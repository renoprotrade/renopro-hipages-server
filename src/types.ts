export interface HiPagesJobRequest {
  categorySlug: string;
  categoryName: string;
  postcode: string;
  suburb?: string;
  description: string;
  propertyType: string;
  timing: 'asap' | 'within_2_weeks' | 'within_1_month' | 'within_3_months' | 'flexible';
  contact: {
    name: string;
    email: string;
    phone: string;
  };
  photos?: {
    original?: string;
    visualization?: string;
  };
}

export interface HiPagesJobStatus {
  jobId: string;
  status: 'pending' | 'filling_form' | 'uploading_photos' | 'awaiting_otp' | 'submitting' | 'completed' | 'failed';
  message: string;
  hipagesJobId?: string;
  hipagesJobUrl?: string;
  error?: string;
}
