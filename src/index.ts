import express, { raw } from "express";
import dotenv from "dotenv";
dotenv.config();
import cors from "cors";
import { connectDb } from "./config/db";
import { globalErrorHandler } from "./middlewares/globalErrorHandler";
import ApiError from "./errors/apiError";
import userRoutes from "./routes/user.routes";
import availabilityRoutes from "./routes/availability.routes";
import bookingRoutes from "./routes/booking.routes";
import paymentRoutes from "./routes/payment.routes";
import { stripeWebhook } from "./controllers/booking.controller";
import { paymentWebhook } from "./controllers/payment.controller";

const PORT = 4000;

const app = express();

app.use(express.json());

const corsOption = {
  origin: "*",
  credentials: true,
};
app.use(cors(corsOption));

// ── Stripe webhooks (raw body, BEFORE express.json()) ──
app.post(
  "/api/bookings/webhook",
  raw({ type: "application/json" }),
  stripeWebhook
);
app.post(
  "/api/payments/webhook",
  raw({ type: "application/json" }),
  paymentWebhook
);

connectDb();

app.use("/api/users", userRoutes);
app.use("/api/availability", availabilityRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/payments", paymentRoutes);

app.listen(PORT, () => {
  console.log("Server Listening on port 4000...");
});
app.all("*", (req, _res, next) => {
  next(new ApiError(404, `Can't find ${req.originalUrl} on the server!`));
});
app.use(globalErrorHandler);
