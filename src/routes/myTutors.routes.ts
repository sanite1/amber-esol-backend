import { Router } from "express";
import { isAuthenticated } from "../middlewares/authMiddleWare";
import {
  listMyTutors,
  getMyTutorDetail,
  toggleFavourite,
} from "../controllers/myTutors.controller";
import {
  listMyTutorsValidation,
  getMyTutorDetailValidation,
  toggleFavouriteValidation,
} from "../validations/myTutors.validation";

const router = Router();

// All routes require authentication
router.use(isAuthenticated);

router.get("/", listMyTutorsValidation, listMyTutors);
router.get("/:tutorId", getMyTutorDetailValidation, getMyTutorDetail);
router.post("/:tutorId/favourite", toggleFavouriteValidation, toggleFavourite);

export default router;
