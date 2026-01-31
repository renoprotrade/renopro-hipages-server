/**
 * HiPages Puppeteer Automation
 *
 * Automates the HiPages job posting flow
 */

import puppeteer, { Browser, Page } from 'puppeteer';
import { HiPagesJobRequest, HiPagesJobStatus } from './types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Store active browser sessions
const activeSessions: Map<string, { browser: Browser; page: Page; status: HiPagesJobStatus }> = new Map();

/**
 * Promise-based delay helper
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Find a button by text content and click it
 */
async function findAndClickButton(page: Page, texts: string[]): Promise<boolean> {
  for (const text of texts) {
    const buttons = await page.$$('button, input[type="submit"], a');
    for (const button of buttons) {
      const buttonText = await page.evaluate(el => el.textContent?.toLowerCase() || '', button);
      if (buttonText.includes(text.toLowerCase())) {
        await button.click();
        return true;
      }
    }
  }
  return false;
}

/**
 * Start a new HiPages job posting session
 */
export async function startJobPosting(
  jobId: string,
  jobData: HiPagesJobRequest,
  onStatusUpdate: (status: HiPagesJobStatus) => void
): Promise<void> {
  let browser: Browser | null = null;

  try {
    const updateStatus = (status: Partial<HiPagesJobStatus>) => {
      const currentStatus = activeSessions.get(jobId)?.status || {
        jobId,
        status: 'pending',
        message: 'Starting...',
      };
      const newStatus = { ...currentStatus, ...status } as HiPagesJobStatus;
      if (activeSessions.has(jobId)) {
        activeSessions.get(jobId)!.status = newStatus;
      }
      onStatusUpdate(newStatus);
    };

    updateStatus({ status: 'pending', message: 'Launching browser...' });

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
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    activeSessions.set(jobId, {
      browser,
      page,
      status: { jobId, status: 'pending', message: 'Browser launched' },
    });

    updateStatus({ status: 'filling_form', message: 'Navigating to HiPages...' });

    await page.goto('https://www.hipages.com.au/get-quotes', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    await page.waitForSelector('input', { timeout: 10000 });

    updateStatus({ message: 'Filling category...' });
    await fillCategory(page, jobData.categoryName);

    updateStatus({ message: 'Filling location...' });
    await fillLocation(page, jobData.postcode);

    await clickGetQuotes(page);

    updateStatus({ message: 'Answering questions...' });
    await answerFormQuestions(page);

    updateStatus({ message: 'Filling job description...' });
    await fillDescription(page, jobData.description);

    if (jobData.photos?.original || jobData.photos?.visualization) {
      updateStatus({ status: 'uploading_photos', message: 'Uploading photos...' });
      await uploadPhotos(page, jobData.photos);
    }

    updateStatus({ message: 'Filling contact details...' });
    await fillContactDetails(page, jobData.contact);

    updateStatus({ status: 'awaiting_otp', message: `Enter the code sent to ${jobData.contact.phone}` });

  } catch (error) {
    console.error('[HiPages] Error during job posting:', error);

    if (browser) {
      await browser.close();
    }
    activeSessions.delete(jobId);

    onStatusUpdate({
      jobId,
      status: 'failed',
      message: 'Failed to post job',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Submit OTP code to complete the job posting
 */
export async function submitOtp(jobId: string, otpCode: string): Promise<HiPagesJobStatus> {
  const session = activeSessions.get(jobId);

  if (!session) {
    return {
      jobId,
      status: 'failed',
      message: 'Session not found',
      error: 'No active session for this job ID',
    };
  }

  const { browser, page } = session;

  try {
    session.status = { ...session.status, status: 'submitting', message: 'Verifying code...' };

    const otpInput = await page.$('input[type="text"], input[type="number"], input[name*="otp"], input[name*="code"], input[maxlength="6"]');
    if (otpInput) {
      await otpInput.click({ clickCount: 3 });
      await otpInput.type(otpCode, { delay: 50 });
    }

    await findAndClickButton(page, ['verify', 'submit', 'confirm']);

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});

    const currentUrl = page.url();
    const jobIdMatch = currentUrl.match(/job\/(\d+)/);
    const hipagesJobId = jobIdMatch ? jobIdMatch[1] : undefined;

    await browser.close();
    activeSessions.delete(jobId);

    return {
      jobId,
      status: 'completed',
      message: 'Job posted successfully!',
      hipagesJobId,
      hipagesJobUrl: hipagesJobId
        ? `https://www.hipages.com.au/account/job/${hipagesJobId}/interested-businesses`
        : undefined,
    };

  } catch (error) {
    console.error('[HiPages] Error submitting OTP:', error);

    await browser.close();
    activeSessions.delete(jobId);

    return {
      jobId,
      status: 'failed',
      message: 'Failed to verify code',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Cancel an active session
 */
export async function cancelSession(jobId: string): Promise<void> {
  const session = activeSessions.get(jobId);
  if (session) {
    await session.browser.close();
    activeSessions.delete(jobId);
  }
}

/**
 * Get current status of a job
 */
export function getJobStatus(jobId: string): HiPagesJobStatus | null {
  return activeSessions.get(jobId)?.status || null;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

async function fillCategory(page: Page, categoryName: string): Promise<void> {
  const inputs = await page.$$('input');
  if (inputs.length > 0) {
    const categoryInput = inputs[0];
    await categoryInput.click();
    await delay(300);
    await categoryInput.type(categoryName, { delay: 100 });
    await delay(1500);

    const suggestion = await page.$('[role="option"], [role="listbox"] li, ul[class*="suggestion"] li, ul[class*="autocomplete"] li');
    if (suggestion) {
      await suggestion.click();
    } else {
      await page.keyboard.press('Enter');
    }
    await delay(500);
  }
}

async function fillLocation(page: Page, postcode: string): Promise<void> {
  const locationInput = await page.$('input[placeholder*="postcode"], input[placeholder*="suburb"], input[placeholder*="location"], input[name*="location"], input[name*="postcode"]');

  if (locationInput) {
    await locationInput.click();
    await delay(300);
    await locationInput.type(postcode, { delay: 100 });
    await delay(1500);

    const suggestion = await page.$('[role="option"], [role="listbox"] li, ul[class*="suggestion"] li');
    if (suggestion) {
      await suggestion.click();
    } else {
      await page.keyboard.press('Enter');
    }
    await delay(500);
  }
}

async function clickGetQuotes(page: Page): Promise<void> {
  const clicked = await findAndClickButton(page, ['get quotes', 'get quote', 'continue', 'next', 'go']);
  if (clicked) {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
  }
}

async function answerFormQuestions(page: Page): Promise<void> {
  await delay(1000);

  for (let i = 0; i < 10; i++) {
    const textarea = await page.$('textarea');
    if (textarea) {
      break;
    }

    const radioButtons = await page.$$('input[type="radio"]:not(:checked)');
    if (radioButtons.length > 0) {
      await radioButtons[0].click();
      await delay(500);
    }

    const clicked = await findAndClickButton(page, ['next', 'continue']);
    if (!clicked) {
      break;
    }
    await delay(1000);
  }
}

async function fillDescription(page: Page, description: string): Promise<void> {
  const textarea = await page.$('textarea');
  if (textarea) {
    await textarea.click();
    await textarea.type(description, { delay: 20 });
    await delay(500);
  }
}

async function uploadPhotos(
  page: Page,
  photos: { original?: string; visualization?: string }
): Promise<void> {
  const fileInput = await page.$('input[type="file"]');

  if (!fileInput) {
    console.log('[HiPages] No file input found, skipping photo upload');
    return;
  }

  const tempDir = os.tmpdir();
  const filesToUpload: string[] = [];

  try {
    if (photos.original) {
      const originalPath = path.join(tempDir, `hipages_original_${Date.now()}.jpg`);
      const base64Data = photos.original.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(originalPath, Buffer.from(base64Data, 'base64'));
      filesToUpload.push(originalPath);
    }

    if (photos.visualization) {
      const vizPath = path.join(tempDir, `hipages_viz_${Date.now()}.jpg`);
      const base64Data = photos.visualization.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(vizPath, Buffer.from(base64Data, 'base64'));
      filesToUpload.push(vizPath);
    }

    if (filesToUpload.length > 0) {
      await fileInput.uploadFile(...filesToUpload);
      await delay(2000);
    }

  } finally {
    for (const file of filesToUpload) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

async function fillContactDetails(
  page: Page,
  contact: { name: string; email: string; phone: string }
): Promise<void> {
  const nameInput = await page.$('input[name*="name"], input[placeholder*="name"], input[autocomplete="name"]');
  if (nameInput) {
    await nameInput.click({ clickCount: 3 });
    await nameInput.type(contact.name, { delay: 50 });
  }

  const emailInput = await page.$('input[type="email"], input[name*="email"], input[placeholder*="email"]');
  if (emailInput) {
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(contact.email, { delay: 50 });
  }

  const phoneInput = await page.$('input[type="tel"], input[name*="phone"], input[placeholder*="phone"], input[name*="mobile"]');
  if (phoneInput) {
    await phoneInput.click({ clickCount: 3 });
    await phoneInput.type(contact.phone, { delay: 50 });
  }

  await delay(500);

  await findAndClickButton(page, ['get quotes', 'submit', 'continue', 'send']);
  await delay(2000);
}
