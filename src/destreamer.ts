import { argv } from './CommandLineParser';
import { ERROR_CODE } from './Errors';
import { setProcessEvents } from './Events';
import { logger } from './Logger';
import { getPuppeteerChromiumPath } from './PuppeteerHelper';
import { drawThumbnail } from './Thumbnail';
import { TokenCache, refreshSession } from './TokenCache';
import { Video, Session } from './Types';
import { checkRequirements, ffmpegTimemarkToChunk, parseInputFile, parseCLIinput} from './Utils';
import { getVideoInfo, createUniquePath } from './VideoUtils';

import cliProgress from 'cli-progress';
import readline from 'readline';
import fs from 'fs';
import isElevated from 'is-elevated';
import puppeteer from 'puppeteer';
import { ApiClient } from './ApiClient';


const { FFmpegCommand, FFmpegInput, FFmpegOutput } = require('@tedconf/fessonia')();
const tokenCache: TokenCache = new TokenCache();
export const chromeCacheFolder = '.chrome_data';


async function init(): Promise<void> {
    setProcessEvents(); // must be first!

    if (argv.verbose) {
        logger.level = 'verbose';
    }

    if (await isElevated()) {
        process.exit(ERROR_CODE.ELEVATED_SHELL);
    }

    checkRequirements();

    if (argv.username) {
        logger.info(`Username: ${argv.username}`);
    }

    if (argv.simulate) {
        logger.warn('Simulate mode, there will be no video downloaded. \n');
    }
}

async function askUnipiCredentaials() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true
    });

    const questionAsync = (query:string) => {
        return new Promise<string>((resolve, reject) => {
            rl.question(query, (answer:string) => resolve(answer) );
        });
    };
    
    console.log("Plese provide your UNIPI credentials")
    const unipi_usr = await questionAsync("Username: ");
    const unipi_psw = await questionAsync("Password: ");
    
    let save_cred_asw = "";
    while (!save_cred_asw.startsWith("y") && !save_cred_asw.startsWith("n")) {
        save_cred_asw = await questionAsync("Do you want to save the credentials for the next time? [y/n] ");
        save_cred_asw = save_cred_asw.toLowerCase();
    }
    const save_credentials = (save_cred_asw.startsWith("y")) ? true : false;
    
    return { unipi_usr, unipi_psw, save_credentials };
}

async function getUnipiCredentials() {
    const credentials_path = "credentials.txt";
    let file_exists:boolean;
    try {
        await fs.promises.access(credentials_path);
        file_exists = true;
    } catch (err) {
        file_exists = false;
    }

    // Reading from credentials.txt if file exists
    if (file_exists) {
        const contents = await fs.promises.readFile(credentials_path, 'utf8');
        const unipi_usr = contents.split("\n")[0];
        const unipi_psw = contents.split("\n")[1];

        return { unipi_usr, unipi_psw };
    }

    // Get credentials from console input
    const credentials = await askUnipiCredentaials();
    if (credentials.save_credentials) {
        // Saving credentials to file
        const data = credentials.unipi_usr + "\n" + credentials.unipi_psw;
        fs.promises.writeFile(credentials_path, data, 'utf8');
    }

    return {
        unipi_usr: credentials.unipi_usr,
        unipi_psw: credentials.unipi_psw
    };
}


async function DoInteractiveLogin(url: string, username?: string): Promise<Session> {
    //const videoId = url.split('/').pop(); //?? process.exit(ERROR_CODE.INVALID_VIDEO_ID);
    
    //*********************************************  ADDING UNIPI CREDENTIALS
    const credentials = await getUnipiCredentials();
    let unipi_usr:string = credentials.unipi_usr;
    let unipi_psw:string = credentials.unipi_psw;
	
    if (!username){
    	username = "no_need_to_change@studenti.unipi.it"	
    }
    //*********************************************

    logger.info('Launching headless Chrome to perform the OpenID Connect dance...');

    const browser: puppeteer.Browser = await puppeteer.launch({
        executablePath: getPuppeteerChromiumPath(),
        headless: true,	//unipi: no need to show the window now, software asks in the shell
        userDataDir: (argv.keepLoginCookies) ? chromeCacheFolder : undefined,
        args: [
            '--disable-dev-shm-usage',
            '--fast-start',
            '--no-sandbox'
        ]
    });
    const page: puppeteer.Page = (await browser.pages())[0];

    logger.info('Navigating to login page...');
    await page.goto(url, { waitUntil: 'load' });

    if (username) { // per essere coerenti con il testo originale, ovviamente è sempre vero visto quanto fatto sopra
        await page.waitForSelector('input[type="email"]');
        await page.keyboard.type(username);
        await page.click('input[type="submit"]');
        
        //********************* HANDLING UNIPI PAGE
        await page.waitForSelector('input[type="text"]');
        await page.type('input[type="text"]', unipi_usr.replace("@studenti.unipi.it","")); // per il login non serve la mail
        await page.type('input[type="password"]', unipi_psw);
        await page.click('button[type="submit"]');
        
        await page.waitForSelector('input[type="submit"]');
        await page.click('input[type="submit"]');
        //*********************
    }
    else { // non viene mai chiamato
        /* If there is no email input selector we aren't in the login module,
        we are probably using the cache to aid the login.
        It could finish the login on its own if the user said 'yes' when asked to
        remember the credentials or it could still prompt the user for a password */
    }

    await browser.waitForTarget((target: puppeteer.Target) => target.url().endsWith('microsoftstream.com/'), { timeout: 150000 });
    logger.info('We are logged in.');

    let session: Session | null = null;
    let tries = 1;
    while (!session) {
        try {
            let sessionInfo: any;
            session = await page.evaluate(
                () => {
                    return {
                        AccessToken: sessionInfo.AccessToken,
                        ApiGatewayUri: sessionInfo.ApiGatewayUri,
                        ApiGatewayVersion: sessionInfo.ApiGatewayVersion
                    };
                }
            );
        }
        catch (error) {
            if (tries > 5) {
                process.exit(ERROR_CODE.NO_SESSION_INFO);
            }

            session = null;
            tries++;
            await page.waitFor(3000);
        }
    }

    tokenCache.Write(session);
    logger.info('Wrote access token to token cache.');
    logger.info("At this point Chromium's job is done, shutting it down...\n");

    await browser.close();

    return session;
}


async function downloadVideo(videoGUIDs: Array<string>, outputDirectories: Array<string>, session: Session): Promise<void> {

    logger.info('Fetching videos info... \n');
    const videos: Array<Video> = createUniquePath (
        await getVideoInfo(videoGUIDs, session, argv.closedCaptions),
        outputDirectories, argv.outputTemplate, argv.format, argv.skip
        );

    if (argv.simulate) {
        videos.forEach((video: Video) => {
            logger.info(
                '\nTitle:          '.green + video.title +
                '\nOutPath:        '.green + video.outPath +
                '\nPublished Date: '.green + video.publishDate +
                '\nPlayback URL:   '.green + video.playbackUrl +
                ((video.captionsUrl) ? ('\nCC URL:         '.green + video.captionsUrl) : '')
            );
        });

        return;
    }

    for (const [index, video] of videos.entries()) {

        if (argv.skip && fs.existsSync(video.outPath)) {
            logger.info(`File already exists, skipping: ${video.outPath} \n`);
            continue;
        }

        if (argv.keepLoginCookies && index !== 0) {
            logger.info('Trying to refresh token...');
            session = await refreshSession('https://web.microsoftstream.com/video/' + videoGUIDs[index]);
            ApiClient.getInstance().setSession(session);
        }

        const pbar: cliProgress.SingleBar = new cliProgress.SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            format: 'progress [{bar}] {percentage}% {speed} {eta_formatted}',
            // process.stdout.columns may return undefined in some terminals (Cygwin/MSYS)
            barsize: Math.floor((process.stdout.columns || 30) / 3),
            stopOnComplete: true,
            hideCursor: true,
        });

        logger.info(`\nDownloading Video: ${video.title} \n`);
        logger.verbose('Extra video info \n' +
        '\t Video m3u8 playlist URL: '.cyan + video.playbackUrl + '\n' +
        '\t Video tumbnail URL: '.cyan + video.posterImageUrl + '\n' +
        '\t Video subtitle URL (may not exist): '.cyan + video.captionsUrl + '\n' +
        '\t Video total chunks: '.cyan + video.totalChunks + '\n');

        logger.info('Spawning ffmpeg with access token and HLS URL. This may take a few seconds...\n\n');
        if (!process.stdout.columns) {
            logger.warn(
                'Unable to get number of columns from terminal.\n' +
                'This happens sometimes in Cygwin/MSYS.\n' +
                'No progress bar can be rendered, however the download process should not be affected.\n\n' +
                'Please use PowerShell or cmd.exe to run destreamer on Windows.'
            );
        }

        const headers: string = 'Authorization: Bearer ' + session.AccessToken;

        if (!argv.noExperiments) {
            await drawThumbnail(video.posterImageUrl, session);
        }

        const ffmpegInpt: any = new FFmpegInput(video.playbackUrl, new Map([
            ['headers', headers]
        ]));
        const ffmpegOutput: any = new FFmpegOutput(video.outPath, new Map([
            argv.acodec === 'none' ? ['an', null] : ['c:a', argv.acodec],
            argv.vcodec === 'none' ? ['vn', null] : ['c:v', argv.vcodec],
            ['n', null]
        ]));
        const ffmpegCmd: any = new FFmpegCommand();

        const cleanupFn: () => void = () => {
            pbar.stop();

           if (argv.noCleanup) {
               return;
           }

            try {
                fs.unlinkSync(video.outPath);
            }
            catch (e) {
                // Future handling of an error (maybe)
            }
        };

        pbar.start(video.totalChunks, 0, {
            speed: '0'
        });

        // prepare ffmpeg command line
        ffmpegCmd.addInput(ffmpegInpt);
        ffmpegCmd.addOutput(ffmpegOutput);
        if (argv.closedCaptions && video.captionsUrl) {
            const captionsInpt: any = new FFmpegInput(video.captionsUrl, new Map([
                ['headers', headers]
            ]));

            ffmpegCmd.addInput(captionsInpt);
        }

        ffmpegCmd.on('update', async (data: any) => {
            const currentChunks: number = ffmpegTimemarkToChunk(data.out_time);

            pbar.update(currentChunks, {
                speed: data.bitrate
            });

            // Graceful fallback in case we can't get columns (Cygwin/MSYS)
            if (!process.stdout.columns) {
                process.stdout.write(`--- Speed: ${data.bitrate}, Cursor: ${data.out_time}\r`);
            }
        });

        process.on('SIGINT', cleanupFn);

        // let the magic begin...
        await new Promise((resolve: any) => {
            ffmpegCmd.on('error', (error: any) => {
                cleanupFn();

                logger.error(`FFmpeg returned an error: ${error.message}`);
                process.exit(ERROR_CODE.UNK_FFMPEG_ERROR);
            });

            ffmpegCmd.on('success', () => {
                pbar.update(video.totalChunks); // set progress bar to 100%
                logger.info(`\nDownload finished: ${video.outPath} \n`);
                resolve();
            });

            ffmpegCmd.spawn();
        });

        process.removeListener('SIGINT', cleanupFn);
    }
}


async function main(): Promise<void> {
    await init(); // must be first

    let session: Session;
    // eslint-disable-next-line prefer-const
    session = tokenCache.Read() ?? await DoInteractiveLogin('https://web.microsoftstream.com/', argv.username);

    logger.verbose('Session and API info \n' +
        '\t API Gateway URL: '.cyan + session.ApiGatewayUri + '\n' +
        '\t API Gateway version: '.cyan + session.ApiGatewayVersion + '\n');

    let videoGUIDs: Array<string>;
    let outDirs: Array<string>;

    if (argv.videoUrls) {
        logger.info('Parsing video/group urls');
        [videoGUIDs, outDirs] =  await parseCLIinput(argv.videoUrls as Array<string>, argv.outputDirectory, session);
    }
    else {
        logger.info('Parsing input file');
        [videoGUIDs, outDirs] =  await parseInputFile(argv.inputFile!, argv.outputDirectory, session);
    }

    logger.verbose('List of GUIDs and corresponding output directory \n' +
        videoGUIDs.map((guid: string, i: number) =>
            `\thttps://web.microsoftstream.com/video/${guid} => ${outDirs[i]} \n`).join(''));


    downloadVideo(videoGUIDs, outDirs, session);
}


main();
