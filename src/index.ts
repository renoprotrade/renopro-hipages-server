import express, { Request, Response } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { HiPagesJobRequest, HiPagesJobStatus } from './types';
import { startJobPosting, submitOtp, cancelSession, getJobStatus } from './hipages-automation';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const jobStatuses: Map<string, HiPagesJobStatus> = new Map();

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/jobs', async (req: Request, res: Response) => {
  try {
    const jobData: HiPagesJobRequest = req.body;

    if (!jobData.categoryName || !jobData.postcode || !jobData.description) {
      res.status(400).json({
        error: 'Missing required fields',
        required: ['categoryName', 'postcode', 'description', 'contact']
      });
      return;
    }

    if (!jobData.contact?.name || !jobData.contact?.email || !jobData.contact?.phone) {
      res.status(400).json({
        error: 'Missing contact information',
        required: ['contact.name', 'contact.email', 'contact.phone']
      });
      return;
    }

    const jobId = uuidv4();

    const initialStatus: HiPagesJobStatus = {
      jobId,
      status: 'pending',
      message: 'Job queued for processing'
    };
    jobStatuses.set(jobId, initialStatus);

    startJobPosting(jobId, jobData, (status) => {
      jobStatuses.set(jobId, status);
      console.log(`[Job ${jobId}] Status update:`, status.status, '-', status.message);
    }).catch((error) => {
      console.error(`[Job ${jobId}] Fatal error:`, error);
      jobStatuses.set(jobId, {
        jobId,
        status: 'failed',
        message: 'Job processing failed',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    });

    res.status(202).json(initialStatus);

  } catch (error) {
    console.error('[API] Error starting job:', error);
    res.status(500).json({
      error: 'Failed to start job',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.get('/api/jobs/:jobId', (req: Request, res: Response) => {
  const { jobId } = req.params;
  const status = jobStatuses.get(jobId) || getJobStatus(jobId);

  if (!status) {
    res.status(404).json({ error: 'Job not found', jobId });
    return;
  }

  res.json(status);
});

app.post('/api/jobs/:jobId/otp', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const { otp } = req.body;

    if (!otp) {
      res.status(400).json({ error: 'OTP code is required' });
      return;
    }

    const currentStatus = jobStatuses.get(jobId) || getJobStatus(jobId);

    if (!currentStatus) {
      res.status(404).json({ error: 'Job not found', jobId });
      return;
    }

    if (currentStatus.status !== 'awaiting_otp') {
      res.status(400).json({ error: 'Job is not awaiting OTP', currentStatus: currentStatus.status });
      return;
    }

    const finalStatus = await submitOtp(jobId, otp);
    jobStatuses.set(jobId, finalStatus);

    res.json(finalStatus);

  } catch (error) {
    console.error('[API] Error submitting OTP:', error);
    res.status(500).json({
      error: 'Failed to submit OTP',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.delete('/api/jobs/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    await cancelSession(jobId);
    jobStatuses.delete(jobId);
    res.json({ success: true, message: 'Job cancelled' });
  } catch (error) {
    console.error('[API] Error cancelling job:', error);
    res.status(500).json({
      error: 'Failed to cancel job',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.listen(PORT, () => {
  console.log(`RenoPro HiPages Server running on port ${PORT}`);
});
