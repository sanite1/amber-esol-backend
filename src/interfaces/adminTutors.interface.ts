/* ── Query params for admin tutor list ── */

export interface IAdminTutorsQuery {
  page?: string;
  limit?: string;
  search?: string;
  status?: string; // "all" | "active" | "inactive" | "pending_approval" | "rejected" | "banned"
  sort?: string; // "newest" | "name" | "earned" | "rating" | "lessons" | "students"
}

/* ── Admin update tutor status ── */

export interface IAdminUpdateTutorStatusRequest {
  status: "active" | "inactive" | "pending_approval" | "rejected" | "banned";
  reason?: string;
}
