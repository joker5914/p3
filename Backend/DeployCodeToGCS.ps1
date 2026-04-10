gcloud builds submit --tag gcr.io/p3-fastapi/dismissal-backend
gcloud run deploy dismissal-backend `
  --image gcr.io/p3-fastapi/dismissal-backend `
  --platform managed `
  --region us-central1 `
  --set-env-vars=DISMISSAL_ENCRYPTION_KEY="u1/hjyMOxIs4kFwr6xqQYwxn00hbe3urLCYPTt8y6ug=" `
  --allow-unauthenticated