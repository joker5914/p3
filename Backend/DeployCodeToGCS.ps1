gcloud builds submit --tag gcr.io/p3-fastapi/p3-backend
gcloud run deploy p3-backend `
  --image gcr.io/p3-fastapi/p3-backend `
  --platform managed `
  --region us-central1 `
  --set-env-vars=P3_ENCRYPTION_KEY="u1/hjyMOxIs4kFwr6xqQYwxn00hbe3urLCYPTt8y6ug=" `
  --allow-unauthenticated