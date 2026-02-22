const ALLOWED_ORIGINS = [
  "https://esol.ambertraining.co.uk",
  "https://app.ambertraining.co.uk",
  "https://ambertraining.co.uk",
  "https://www.ambertraining.co.uk",
  ...(process.env.NODE_ENV !== "production"
    ? [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:3002",
      ]
    : []),
];

export default ALLOWED_ORIGINS;
