export default () => ({
  port: parseInt(process.env.PORT, 10) || 3000,
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/afrikart',
  afrikart: {
    baseUrl: process.env.AFRIKART_BASE_URL,
    secretKey: process.env.AFRIKART_SECRET_KEY,
    publicKey: process.env.AFRIKART_PUBLIC_KEY,
    webhookSecret: process.env.AFRIKART_WEBHOOK_SECRET,
  },
  // How long before a PROCESSING payout is flagged UNCERTAIN (ms)
  payoutUncertaintyThresholdMs:
    parseInt(process.env.PAYOUT_UNCERTAINTY_THRESHOLD_MS, 10) || 60_000,
});
