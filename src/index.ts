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
import tutorDashboardRoutes from "./routes/tutorDashboard.routes";
import studentDashboardRoutes from "./routes/studentDashboard.routes";
import adminDashboardRoutes from "./routes/adminDashboard.routes";
import cronRoutes from "./routes/cron.routes";
import { stripeWebhook } from "./controllers/webhook.controller";
import { initSocketIO } from "./services/websocket.service";

const PORT = 4000;

const app = express();
const server = createServer(app);

const corsOption = {
  origin: "*",
  credentials: true,
};
app.use(cors(corsOption));

(async () => {
  // ── Stripe webhook MUST be before express.json() ──
  app.post(
    "/api/webhooks/stripe",
    raw({ type: "application/json" }),
    stripeWebhook
  );

  app.use(express.json());

  connectDb();

  // ── Initialise WebSocket ──
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
  app.use("/api/tutor-dashboard", tutorDashboardRoutes);
  app.use("/api/student-dashboard", studentDashboardRoutes);
  app.use("/api/admin-dashboard", adminDashboardRoutes);
  app.use("/api/cron", cronRoutes);

  // ── Use server.listen instead of app.listen for Socket.IO ──
  server.listen(PORT, () => {
    console.log("Server Listening on port 4000...");
  });

  app.all("*", (req, _res, next) => {
    next(new ApiError(404, `Can't find ${req.originalUrl} on the server!`));
  });
  app.use(globalErrorHandler);
})();
