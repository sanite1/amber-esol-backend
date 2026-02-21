/* ── Query params for admin student list ── */

export interface IAdminStudentsQuery {
  page?: string;
  limit?: string;
  search?: string;
  status?: string; // "all" | "active" | "inactive" | "banned"
  sort?: string; // "newest" | "name" | "spent" | "lessons" | "recent"
}

/* ── Admin update student status ── */

export interface IAdminUpdateStudentStatusRequest {
  status: "active" | "inactive" | "banned";
  reason?: string;
}
