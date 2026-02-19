import { Router } from "express";
import { isAuthenticated, isTutor } from "../middlewares/authMiddleWare";
import {
  listMyStudentsValidation,
  myStudentDetailValidation,
  updateStudentNotesValidation,
} from "../validations/myStudents.validation";
import {
  listMyStudents,
  getMyStudentDetail,
  updateStudentNotes,
} from "../controllers/myStudents.controller";

const router = Router();

// All routes require authenticated tutor
router.use(isAuthenticated, isTutor);

// GET  /api/my-students
router.get("/", listMyStudentsValidation, listMyStudents);

// GET  /api/my-students/:studentId
router.get("/:studentId", myStudentDetailValidation, getMyStudentDetail);

// PATCH /api/my-students/:studentId/notes
router.patch(
  "/:studentId/notes",
  updateStudentNotesValidation,
  updateStudentNotes
);

export default router;
