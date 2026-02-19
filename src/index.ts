import express, { raw } from "express";
import dotenv from "dotenv";
dotenv.config();
import cors from "cors";
import { createServer } from "http";
import { connectDb } from "./config/db";
import { globalErrorHandler } from "./middlewares/globalErrorHandler";
import ApiError from "./errors/apiError";
import userRoutes from "./routes/user.routes";
import availabilityRoutes from "./routes/availability.routes";
import bookingRoutes from "./routes/booking.routes";
import paymentRoutes from "./routes/payment.routes";
import reviewRoutes from "./routes/review.routes";
import messagingRoutes from "./routes/messaging.routes";
import notificationRoutes from "./routes/notification.routes";
import myTutorsRoutes from "./routes/myTutors.routes";
import myStudentsRoutes from "./routes/myStudents.routes";
import { stripeWebhook } from "./controllers/booking.controller";
import { paymentWebhook } from "./controllers/payment.controller";
import { initSocketIO } from "./services/websocket.service";

const PORT = 4000;

const app = express();
const server = createServer(app);

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

// ── Initialise WebSocket ── ← NEW
initSocketIO(server);

app.use("/api/users", userRoutes);
app.use("/api/availability", availabilityRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/conversations", messagingRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/my-tutors", myTutorsRoutes);
app.use("/api/my-students", myStudentsRoutes);

// ── Use server.listen instead of app.listen for Socket.IO ── ← CHANGED
server.listen(PORT, () => {
  console.log("Server Listening on port 4000...");
});

app.all("*", (req, _res, next) => {
  next(new ApiError(404, `Can't find ${req.originalUrl} on the server!`));
});
app.use(globalErrorHandler);
