import express from "express";
import dotenv from "dotenv";
dotenv.config();
import cors from "cors";
import { connectDb } from "./config/db";
import { globalErrorHandler } from "./middlewares/globalErrorHandler";
import ApiError from "./errors/apiError";
import userRoutes from "./routes/user.routes";

const PORT = 4000;

const app = express();

app.use(express.json());

const corsOption = {
  origin: "*",
  credentials: true,
};
app.use(cors(corsOption));

connectDb();

app.use("/api/users", userRoutes);

app.listen(PORT, () => {
  console.log("Server Listening on port 4000...");
});
app.all("*", (req, _res, next) => {
  next(new ApiError(404, `Can't find ${req.originalUrl} on the server!`));
});
app.use(globalErrorHandler);
