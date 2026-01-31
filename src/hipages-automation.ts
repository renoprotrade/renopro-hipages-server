import puppeteer, { Browser, Page } from 'puppeteer';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HiPagesJobRequest, HiPagesJobStatus } from './types';

interface SessionData {
  browser: Browser;
  page: Page;
  jobData: HiPagesJobRequest;
  status: HiPagesJobStatus;
}

const activeSessions: Map<string, SessionData> = new Map();

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function startJobPosting(
  jobId: string,
  jobData: HiPagesJobRequest,
  onStatusUpdate: (status: HiPagesJobStatus) => void
): Promise<void> {
  let browser: Browser | null = null;

  try {
    onStatusUpdate({
      jobId,
      status: 'pending',
      message: 'Launching browser...'
    });

    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,800',
        '--disable-software-rasterizer',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    activeSessions.set(jobId, {
      browser,
      page,
      jobData,
      status: { jobId, status: 'filling_form', message: 'Starting...' }
    });

    onStatusUpdate({
      jobId,
      status: 'filling_form',
      message: 'Navigating to HiPages...'
    });

    await page.goto('https://hipages.com.au/get-quotes', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    onStatusUpdate({
      jobId,
      status: 'filling_form',
      message: 'Selecting category...'
    });

    await fillCategory(page, jobData.categoryName);

    onStatusUpdate({
      jobId,
      status: 'filling_form',
      message: 'Entering location...'
    });

    await fillLocation(page, jobData.postcode);

    onStatusUpdate({
      jobId,
      status: 'filling_form',
      message: 'Getting quotes form...'
    });

    await clickGetQuotes(page);
    await delay(2000);

    onStatusUpdate({
      jobId,
      status: 'filling_form',
      message: 'Answering questions...'
    });

    await answerFormQuestions(page, jobData);

    onStatusUpdate({
      jobId,
      status: 'filling_form',
      message: 'Adding job description...'
    });

    await fillDescription(page, jobData.description);

    if (jobData.photos?.original || jobData.photos?.visualization) {
      onStatusUpdate({
        jobId,
        status: 'uploading_photos',
        message: 'Uploading photos...'
      });

      await uploadPhotos(page, jobData.photos);
    }

    onStatusUpdate({
      jobId,
      status: 'filling_form',
      message: 'Entering contact details...'
    });

    await fillContactDetails(page, jobData.contact);

    onStatusUpdate({
      jobId,
      status: 'awaiting_otp',
      message: 'Please enter the verification code sent to your phone'
    });

    const session = activeSessions.get(jobId);
    if (session) {
      session.status = {
        jobId,
        status: 'awaiting_otp',
        message: 'Waiting for OTP verification'
      };
    }

  } catch (error) {
    console.error(`[Job ${jobId}] Error:`, error);

    if (browser) {
      await browser.close().catch(() => {});
    }
    activeSessions.delete(jobId);

    onStatusUpdate({
      jobId,
      status: 'failed',
      message: 'Job posting failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

export async function submitOtp(jobId: string, otp: string): Promise<HiPagesJobStatus> {
  const session = activeSessions.get(jobId);

  if (!session) {
    return {
      jobId,
      status: 'failed',
      message: 'Session not found',
      error: 'No active session for this job'
    };
  }

  try {
    const { page, browser } = session;

    const otpInput = await page.$('input[type="text"][maxlength="6"], input[name="otp"], input[placeholder*="code"]');
    if (otpInput) {
      await otpInput.type(otp, { delay: 100 });
    }

    const verifyButton = await page.$('button[type="submit"], button:has-text("Verify"), button:has-text("Submit")');
    if (verifyButton) {
      await verifyButton.click();
    }

    await delay(3000);

    const currentUrl = page.url();
    const pageContent = await page.content();

    let hipagesJobId: string | undefined;
    let hipagesJobUrl: string | undefined;

    const jobIdMatch = currentUrl.match(/job[_-]?id[=\/](\d+)/i) || pageContent.match(/job[_-]?id["\s:]+(\d+)/i);
    if (jobIdMatch) {
      hipagesJobId = jobIdMatch[1];
      hipagesJobUrl = `https://hipages.com.au/jobs/${hipagesJobId}`;
    }

    await browser.close();
    activeSessions.delete(jobId);

    return {
      jobId,
      status: 'completed',
      message: 'Job posted successfully!',
      hipagesJobId,
      hipagesJobUrl
    };

  } catch (error) {
    console.error(`[Job ${jobId}] OTP error:`, error);

    if (session.browser) {
      await session.browser.close().catch(() => {});
    }
    activeSessions.delete(jobId);

    return {
      jobId,
      status: 'failed',
      message: 'Failed to verify OTP',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

export async function cancelSession(jobId: string): Promise<void> {
  const session = activeSessions.get(jobId);
  if (session) {
    await session.browser.close().catch(() => {});
    activeSessions.delete(jobId);
  }
}

export function getJobStatus(jobId: string): HiPagesJobStatus | null {
  const session = activeSessions.get(jobId);
  return session?.status || null;
}

async function fillCategory(page: Page, categoryName: string): Promise<void> {
  const searchInput = await page.$('input[type="search"], input[placeholder*="search"], input[placeholder*="trade"]');
  if (searchInput) {
    await searchInput.type(categoryName, { delay: 50 });
    await delay(1000);
    const suggestion = await page.$('[role="option"], .suggestion, .autocomplete-item');
    if (suggestion) {
      await suggestion.click();
    } else {
      await page.keyboard.press('Enter');
    }
  }
  await delay(500);
}

async function fillLocation(page: Page, postcode: string): Promise<void> {
  const locationInput = await page.$('input[placeholder*="postcode"], input[placeholder*="suburb"], input[name*="location"]');
  if (locationInput) {
    await locationInput.type(postcode, { delay: 50 });
    await delay(1000);
    const suggestion = await page.$('[role="option"], .suggestion, .autocomplete-item');
    if (suggestion) {
      await suggestion.click();
    }
  }
  await delay(500);
}

async function clickGetQuotes(page: Page): Promise<void> {
  const button = await page.$('button[type="submit"], button:has-text("Get Quotes"), button:has-text("Continue")');
  if (button) {
    await button.click();
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
  }
}

async function answerFormQuestions(page: Page, jobData: HiPagesJobRequest): Promise<void> {
  await delay(1000);

  const radioButtons = await page.$$('input[type="radio"]');
  for (const radio of radioButtons.slice(0, 5)) {
    try {
      await radio.click();
      await delay(300);
    } catch {}
  }

  const continueButtons = await page.$$('button:has-text("Continue"), button:has-text("Next")');
  for (const btn of continueButtons) {
    try {
      await btn.click();
      await delay(1000);
    } catch {}
  }
}

async function fillDescription(page: Page, description: string): Promise<void> {
  const textarea = await page.$('textarea, input[type="text"][name*="description"]');
  if (textarea) {
    await textarea.type(description, { delay: 20 });
  }
  await delay(500);
}

async function uploadPhotos(
  page: Page,
  photos: { original?: string; visualization?: string }
): Promise<void> {
  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) return;

  const tempFiles: string[] = [];

  try {
    if (photos.original && photos.original.startsWith('data:')) {
      const tempPath = path.join(os.tmpdir(), `hipages_original_${Date.now()}.jpg`);
      const base64Data = photos.original.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(tempPath, base64Data, 'base64');
      tempFiles.push(tempPath);
    }

    if (photos.visualization && photos.visualization.startsWith('data:')) {
      const tempPath = path.join(os.tmpdir(), `hipages_viz_${Date.now()}.jpg`);
      const base64Data = photos.visualization.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(tempPath, base64Data, 'base64');
      tempFiles.push(tempPath);
    }

    if (tempFiles.length > 0) {
      await fileInput.uploadFile(...tempFiles);
      await delay(2000);
    }
  } finally {
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}

async function fillContactDetails(
  page: Page,
  contact: { name: string; email: string; phone: string }
): Promise<void> {
  const nameInput = await page.$('input[name*="name"], input[placeholder*="name"]');
  if (nameInput) {
    await nameInput.type(contact.name, { delay: 30 });
  }

  const emailInput = await page.$('input[type="email"], input[name*="email"]');
  if (emailInput) {
    await emailInput.type(contact.email, { delay: 30 });
  }

  const phoneInput = await page.$('input[type="tel"], input[name*="phone"], input[name*="mobile"]');
  if (phoneInput) {
    await phoneInput.type(contact.phone, { delay: 30 });
  }

  await delay(500);

  const submitButton = await page.$('button[type="submit"], button:has-text("Submit"), button:has-text("Get Quotes")');
  if (submitButton) {
    await submitButton.click();
  }

  await delay(3000);
}
