import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Review from "../models/Review";
import Booking from "../models/Booking";
import User from "../models/User";
import {
  ICreateReviewRequest,
  IUpdateReviewRequest,
  IReplyRequest,
  IReportRequest,
  IReviewQuery,
  IAdminReviewQuery,
  IAdminReviewActionRequest,
  IAdminReportActionRequest,
} from "../interfaces/review.interface";
import {
  sendNewReviewMail,
  sendReviewReplyMail,
  sendReviewReportAdminMail,
  sendReviewHiddenMail,
  sendReviewRestoredMail,
} from "./nodemailer/mail.service";
import {
  createNotification,
  createBulkNotifications,
} from "./notification.service";

/* ══════════════════════════════════════════════
   Helper: recalculate tutor average rating
   ══════════════════════════════════════════════ */

const recalcTutorRating = async (tutorId: string) => {
  const result = await Review.aggregate([
    {
      $match: {
        tutorId: new (require("mongoose").Types.ObjectId)(tutorId),
        status: "published",
      },
    },
    {
      $group: {
        _id: null,
        avg: { $avg: "$rating" },
        count: { $sum: 1 },
        ratings: { $push: "$rating" },
      },
    },
  ]);

  if (result.length > 0) {
    await User.findByIdAndUpdate(tutorId, {
      averageRating: Math.round(result[0].avg * 100) / 100,
      numberOfReviews: result[0].count,
      ratings: result[0].ratings,
    });
  } else {
    await User.findByIdAndUpdate(tutorId, {
      averageRating: 0,
      numberOfReviews: 0,
      ratings: [],
    });
  }
};

/* ══════════════════════════════════════════════
   Service functions
   ══════════════════════════════════════════════ */

/* ── Create Review (student) ── */

export const createReviewService = async (
  studentId: string,
  data: ICreateReviewRequest
) => {
  // 1. Validate booking exists
  const booking = await Booking.findById(data.bookingId);
  if (!booking) {
    throw new ApiError(404, "Booking not found");
  }

  // 2. Ensure the student owns this booking
  if (booking.studentId.toString() !== studentId) {
    throw new ApiError(403, "You can only review your own bookings");
  }

  // 3. Ensure the booking is completed
  if (booking.status !== "completed") {
    throw new ApiError(400, "You can only review completed lessons");
  }

  // 4. Check for existing review
  const existingReview = await Review.findOne({
    bookingId: data.bookingId,
    studentId,
  });
  if (existingReview) {
    throw new ApiError(400, "You have already reviewed this lesson");
  }

  // 5. Create the review
  const review = await Review.create({
    bookingId: booking._id,
    studentId,
    tutorId: booking.tutorId,
    rating: data.rating,
    comment: data.comment,
    lessonTopic: booking.specialty || undefined,
    lessonType: booking.type,
  });

  // 6. Recalculate tutor rating
  await recalcTutorRating(booking.tutorId.toString());

  // 7. Send email to tutor (non-blocking)
  const [student, tutor] = await Promise.all([
    User.findById(studentId),
    User.findById(booking.tutorId),
  ]);

  if (student && tutor) {
    const DOMAIN_NAME = process.env.DOMAIN_NAME || "http://localhost:3000";
    sendNewReviewMail({
      studentName: `${student.firstname} ${student.lastname}`,
      studentEmail: student.email,
      tutorName: tutor.firstname,
      tutorEmail: tutor.email,
      rating: data.rating,
      comment: data.comment,
      lessonTopic: booking.specialty,
      reviewUrl: `${DOMAIN_NAME}/tutor/reviews`,
    }).catch((err) => console.error("Error sending new review email:", err));
  }

  // 8. Notify tutor of new review
  const stars = "★".repeat(data.rating) + "☆".repeat(5 - data.rating);
  createNotification({
    userId: booking.tutorId,
    type: "review_posted",
    title: "New Review Received",
    message: `${student?.firstname || "A student"} ${student?.lastname || ""} left a ${data.rating}-star review (${stars}): "${data.comment.length > 80 ? data.comment.substring(0, 80) + "..." : data.comment}"`,
    data: {
      reviewId: review._id.toString(),
      bookingId: booking._id.toString(),
      rating: data.rating,
      studentId,
      lessonTopic: booking.specialty || null,
    },
  }).catch((err) => console.error("Error creating review notification:", err));

  return new ApiResponse(201, "Review submitted successfully", review.toJSON());
};

/* ── Get Tutor Reviews (public) ── */

export const getTutorReviewsService = async (
  tutorId: string,
  query: IReviewQuery
) => {
  const page = parseInt(query.page || "1", 10);
  const limit = parseInt(query.limit || "10", 10);
  const skip = (page - 1) * limit;

  const filter: any = {
    tutorId,
    status: "published",
  };

  if (query.rating) {
    filter.rating = parseInt(query.rating, 10);
  }

  let sortOption: any = { createdAt: -1 };
  switch (query.sort) {
    case "newest":
      sortOption = { createdAt: -1 };
      break;
    case "oldest":
      sortOption = { createdAt: 1 };
      break;
    case "rating_high":
      sortOption = { rating: -1, createdAt: -1 };
      break;
    case "rating_low":
      sortOption = { rating: 1, createdAt: -1 };
      break;
    case "most_helpful":
      sortOption = { helpfulCount: -1, createdAt: -1 };
      break;
  }

  const [reviews, total] = await Promise.all([
    Review.find(filter)
      .populate("studentId", "firstname lastname profilePicture address")
      .populate("bookingId", "date startTime endTime type specialty")
      .sort(sortOption)
      .skip(skip)
      .limit(limit),
    Review.countDocuments(filter),
  ]);

  return new ApiResponse(200, "Tutor reviews retrieved successfully", {
    reviews: reviews.map((r) => r.toJSON()),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
};

/* ── Get My Reviews (student — reviews they've written) ── */

export const getMyReviewsService = async (
  studentId: string,
  query: IReviewQuery
) => {
  const page = parseInt(query.page || "1", 10);
  const limit = parseInt(query.limit || "10", 10);
  const skip = (page - 1) * limit;

  const filter: any = { studentId };

  let sortOption: any = { createdAt: -1 };
  switch (query.sort) {
    case "newest":
      sortOption = { createdAt: -1 };
      break;
    case "oldest":
      sortOption = { createdAt: 1 };
      break;
    case "rating_high":
      sortOption = { rating: -1 };
      break;
    case "rating_low":
      sortOption = { rating: 1 };
      break;
  }

  const [reviews, total] = await Promise.all([
    Review.find(filter)
      .populate("tutorId", "firstname lastname profilePicture specializations")
      .populate("bookingId", "date startTime endTime type specialty")
      .sort(sortOption)
      .skip(skip)
      .limit(limit),
    Review.countDocuments(filter),
  ]);

  return new ApiResponse(200, "Your reviews retrieved successfully", {
    reviews: reviews.map((r) => r.toJSON()),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
};

/* ── Update Review (student) ── */

export const updateReviewService = async (
  reviewId: string,
  studentId: string,
  data: IUpdateReviewRequest
) => {
  const review = await Review.findById(reviewId);
  if (!review) {
    throw new ApiError(404, "Review not found");
  }

  if (review.studentId.toString() !== studentId) {
    throw new ApiError(403, "You can only edit your own reviews");
  }

  if (review.status === "removed") {
    throw new ApiError(400, "Cannot edit a removed review");
  }

  if (data.rating !== undefined) review.rating = data.rating;
  if (data.comment !== undefined) review.comment = data.comment;

  await review.save();

  // Recalculate if rating changed
  if (data.rating !== undefined) {
    await recalcTutorRating(review.tutorId.toString());
  }

  return new ApiResponse(200, "Review updated successfully", review.toJSON());
};

/* ── Delete Review (student) ── */

export const deleteReviewService = async (
  reviewId: string,
  studentId: string
) => {
  const review = await Review.findById(reviewId);
  if (!review) {
    throw new ApiError(404, "Review not found");
  }

  if (review.studentId.toString() !== studentId) {
    throw new ApiError(403, "You can only delete your own reviews");
  }

  const tutorId = review.tutorId.toString();
  await Review.findByIdAndDelete(reviewId);

  // Recalculate tutor rating
  await recalcTutorRating(tutorId);

  return new ApiResponse(200, "Review deleted successfully");
};

/* ── Add Reply (tutor) ── */

export const addReplyService = async (
  reviewId: string,
  tutorId: string,
  data: IReplyRequest
) => {
  const review = await Review.findById(reviewId);
  if (!review) {
    throw new ApiError(404, "Review not found");
  }

  if (review.tutorId.toString() !== tutorId) {
    throw new ApiError(403, "You can only reply to reviews on your profile");
  }

  if (review.reply) {
    throw new ApiError(
      400,
      "This review already has a reply. Use PATCH to update."
    );
  }

  review.reply = {
    text: data.text,
    createdAt: new Date(),
  };
  await review.save();

  // Send email to student (non-blocking)
  const [student, tutor] = await Promise.all([
    User.findById(review.studentId),
    User.findById(tutorId),
  ]);

  if (student && tutor) {
    const DOMAIN_NAME = process.env.DOMAIN_NAME || "http://localhost:3000";
    sendReviewReplyMail({
      studentName: student.firstname,
      studentEmail: student.email,
      tutorName: `${tutor.firstname} ${tutor.lastname}`,
      replyText: data.text,
      reviewUrl: `${DOMAIN_NAME}/lessons`,
    }).catch((err) => console.error("Error sending review reply email:", err));
  }

  // Notify student that the tutor replied
  createNotification({
    userId: review.studentId,
    type: "review_reply",
    title: "Tutor Replied to Your Review",
    message: `${tutor?.firstname || "Your tutor"} ${tutor?.lastname || ""} replied to your review: "${data.text.length > 80 ? data.text.substring(0, 80) + "..." : data.text}"`,
    data: {
      reviewId: review._id.toString(),
      tutorId: tutorId,
      replyPreview:
        data.text.length > 120
          ? data.text.substring(0, 120) + "..."
          : data.text,
    },
  }).catch((err) =>
    console.error("Error creating review reply notification:", err)
  );

  return new ApiResponse(200, "Reply added successfully", review.toJSON());
};

/* ── Update Reply (tutor) ── */

export const updateReplyService = async (
  reviewId: string,
  tutorId: string,
  data: IReplyRequest
) => {
  const review = await Review.findById(reviewId);
  if (!review) {
    throw new ApiError(404, "Review not found");
  }

  if (review.tutorId.toString() !== tutorId) {
    throw new ApiError(403, "You can only edit your own replies");
  }

  if (!review.reply) {
    throw new ApiError(400, "No reply to update. Use POST to add one.");
  }

  review.reply.text = data.text;
  review.reply.updatedAt = new Date();
  await review.save();

  return new ApiResponse(200, "Reply updated successfully", review.toJSON());
};

/* ── Delete Reply (tutor) ── */

export const deleteReplyService = async (reviewId: string, tutorId: string) => {
  const review = await Review.findById(reviewId);
  if (!review) {
    throw new ApiError(404, "Review not found");
  }

  if (review.tutorId.toString() !== tutorId) {
    throw new ApiError(403, "You can only delete your own replies");
  }

  if (!review.reply) {
    throw new ApiError(400, "No reply to delete");
  }

  review.reply = undefined;
  await review.save();

  return new ApiResponse(200, "Reply deleted successfully", review.toJSON());
};

/* ── Report Review ── */

export const reportReviewService = async (
  reviewId: string,
  reporterId: string,
  data: IReportRequest
) => {
  const review = await Review.findById(reviewId);
  if (!review) {
    throw new ApiError(404, "Review not found");
  }

  // Prevent duplicate reports from the same user
  const alreadyReported = review.reports.some(
    (r) => r.reporterId.toString() === reporterId
  );
  if (alreadyReported) {
    throw new ApiError(400, "You have already reported this review");
  }

  review.reports.push({
    reporterId: reporterId as any,
    reason: data.reason,
    status: "pending",
    createdAt: new Date(),
  });
  review.reported = true;
  await review.save();

  // Notify admin via email (non-blocking)
  const reporter = await User.findById(reporterId);
  if (reporter) {
    const DOMAIN_NAME = process.env.DOMAIN_NAME || "http://localhost:3000";
    sendReviewReportAdminMail({
      reviewId: reviewId,
      reporterName: `${reporter.firstname} ${reporter.lastname}`,
      reason: data.reason,
      adminUrl: `${DOMAIN_NAME}/admin/reviews`,
    }).catch((err) =>
      console.error("Error sending report notification email:", err)
    );
  }

  // Notify all admins via in-app notification
  const admins = await User.find({ role: "admin" }).select("_id").lean();
  if (admins.length > 0) {
    createBulkNotifications({
      userIds: admins.map((a) => a._id),
      type: "review_reported",
      title: "Review Reported",
      message: `${reporter?.firstname || "A user"} ${reporter?.lastname || ""} reported a review: "${data.reason.length > 80 ? data.reason.substring(0, 80) + "..." : data.reason}"`,
      data: {
        reviewId: review._id.toString(),
        reporterId,
        reporterName: reporter
          ? `${reporter.firstname} ${reporter.lastname}`
          : "Unknown",
        reason: data.reason,
        totalReports: review.reports.length,
      },
    }).catch((err) =>
      console.error("Error creating report notifications:", err)
    );
  }

  return new ApiResponse(200, "Review reported successfully");
};

/* ── Toggle Helpful ── */

export const toggleHelpfulService = async (
  reviewId: string,
  userId: string
) => {
  const review = await Review.findById(reviewId);
  if (!review) {
    throw new ApiError(404, "Review not found");
  }

  // Cannot mark your own review as helpful
  if (review.studentId.toString() === userId) {
    throw new ApiError(400, "You cannot mark your own review as helpful");
  }

  const index = review.helpfulBy.findIndex((id) => id.toString() === userId);

  if (index === -1) {
    // Add helpful
    review.helpfulBy.push(userId as any);
    review.helpfulCount += 1;
  } else {
    // Remove helpful (toggle off)
    review.helpfulBy.splice(index, 1);
    review.helpfulCount = Math.max(0, review.helpfulCount - 1);
  }

  await review.save();

  return new ApiResponse(200, "Helpful status updated", {
    helpfulCount: review.helpfulCount,
    isHelpful: index === -1, // true if just added
  });
};

/* ── Review Stats (for tutor profile) ── */

export const reviewStatsService = async (tutorId: string) => {
  const [stats, distribution] = await Promise.all([
    Review.aggregate([
      {
        $match: {
          tutorId: new (require("mongoose").Types.ObjectId)(tutorId),
          status: "published",
        },
      },
      {
        $group: {
          _id: null,
          averageRating: { $avg: "$rating" },
          totalReviews: { $sum: 1 },
          totalHelpful: { $sum: "$helpfulCount" },
        },
      },
    ]),
    Review.aggregate([
      {
        $match: {
          tutorId: new (require("mongoose").Types.ObjectId)(tutorId),
          status: "published",
        },
      },
      {
        $group: {
          _id: "$rating",
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: -1 } },
    ]),
  ]);

  const ratingDistribution: Record<number, number> = {
    5: 0,
    4: 0,
    3: 0,
    2: 0,
    1: 0,
  };
  for (const d of distribution) {
    ratingDistribution[d._id] = d.count;
  }

  const summary = stats[0] || {
    averageRating: 0,
    totalReviews: 0,
    totalHelpful: 0,
  };

  return new ApiResponse(200, "Review stats retrieved successfully", {
    averageRating: Math.round((summary.averageRating || 0) * 100) / 100,
    totalReviews: summary.totalReviews,
    totalHelpful: summary.totalHelpful,
    ratingDistribution,
  });
};

/* ══════════════════════════════════════════════
   Admin Service Functions
   ══════════════════════════════════════════════ */

/* ── Admin: List Reviews ── */

export const adminListReviewsService = async (query: IAdminReviewQuery) => {
  const page = parseInt(query.page || "1", 10);
  const limit = parseInt(query.limit || "10", 10);
  const skip = (page - 1) * limit;

  const filter: any = {};

  if (query.status) {
    filter.status = query.status;
  }

  if (query.reported === "true") {
    filter.reported = true;
  } else if (query.reported === "false") {
    filter.reported = false;
  }

  if (query.search) {
    const searchRegex = new RegExp(query.search, "i");
    const matchingUsers = await User.find({
      $or: [{ firstname: searchRegex }, { lastname: searchRegex }],
    }).select("_id");
    const matchingIds = matchingUsers.map((u) => u._id);

    filter.$or = [
      { studentId: { $in: matchingIds } },
      { tutorId: { $in: matchingIds } },
      { comment: searchRegex },
    ];
  }

  let sortOption: any = { createdAt: -1 };
  switch (query.sort) {
    case "newest":
      sortOption = { createdAt: -1 };
      break;
    case "oldest":
      sortOption = { createdAt: 1 };
      break;
    case "rating_high":
      sortOption = { rating: -1 };
      break;
    case "rating_low":
      sortOption = { rating: 1 };
      break;
    case "most_reported":
      sortOption = { "reports.length": -1, createdAt: -1 };
      break;
  }

  const [reviews, total] = await Promise.all([
    Review.find(filter)
      .populate("studentId", "firstname lastname profilePicture email")
      .populate(
        "tutorId",
        "firstname lastname profilePicture email specializations"
      )
      .populate("bookingId", "date startTime endTime type specialty")
      .populate("reports.reporterId", "firstname lastname email")
      .sort(sortOption)
      .skip(skip)
      .limit(limit),
    Review.countDocuments(filter),
  ]);

  return new ApiResponse(200, "Reviews retrieved successfully", {
    reviews: reviews.map((r) => r.toJSON()),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
};

/* ── Admin: Hide Review ── */

export const adminHideReviewService = async (
  reviewId: string,
  _data: IAdminReviewActionRequest
) => {
  const review = await Review.findById(reviewId);
  if (!review) {
    throw new ApiError(404, "Review not found");
  }

  if (review.status === "hidden") {
    throw new ApiError(400, "Review is already hidden");
  }

  review.status = "hidden";
  await review.save();

  // Recalculate tutor rating (hidden reviews excluded)
  await recalcTutorRating(review.tutorId.toString());

  // Notify student via email (non-blocking)
  const student = await User.findById(review.studentId);
  if (student) {
    const DOMAIN_NAME = process.env.DOMAIN_NAME || "http://localhost:3000";
    sendReviewHiddenMail({
      studentName: student.firstname,
      studentEmail: student.email,
      tutorName: "",
      tutorEmail: "",
      rating: review.rating,
      comment: review.comment,
      reviewUrl: `${DOMAIN_NAME}/lessons`,
    }).catch((err) => console.error("Error sending review hidden email:", err));
  }

  // Notify student via in-app notification
  createNotification({
    userId: review.studentId,
    type: "review_hidden",
    title: "Your Review Has Been Hidden",
    message: `An administrator has hidden your ${review.rating}-star review pending investigation. If you believe this is an error, please contact support.`,
    data: {
      reviewId: review._id.toString(),
      rating: review.rating,
    },
  }).catch((err) =>
    console.error("Error creating review hidden notification:", err)
  );

  return new ApiResponse(200, "Review hidden successfully", review.toJSON());
};

/* ── Admin: Unhide Review ── */

export const adminUnhideReviewService = async (
  reviewId: string,
  _data: IAdminReviewActionRequest
) => {
  const review = await Review.findById(reviewId);
  if (!review) {
    throw new ApiError(404, "Review not found");
  }

  if (review.status !== "hidden") {
    throw new ApiError(400, "Review is not hidden");
  }

  review.status = "published";
  await review.save();

  await recalcTutorRating(review.tutorId.toString());

  // Notify student via email (non-blocking)
  const student = await User.findById(review.studentId);
  if (student) {
    const DOMAIN_NAME = process.env.DOMAIN_NAME || "http://localhost:3000";
    sendReviewRestoredMail({
      studentName: student.firstname,
      studentEmail: student.email,
      tutorName: "",
      tutorEmail: "",
      rating: review.rating,
      comment: review.comment,
      reviewUrl: `${DOMAIN_NAME}/lessons`,
    }).catch((err) =>
      console.error("Error sending review restored email:", err)
    );
  }

  // Notify student via in-app notification
  createNotification({
    userId: review.studentId,
    type: "review_restored",
    title: "Your Review Has Been Restored",
    message: `Your previously hidden ${review.rating}-star review has been restored and is now visible again.`,
    data: {
      reviewId: review._id.toString(),
      rating: review.rating,
    },
  }).catch((err) =>
    console.error("Error creating review restored notification:", err)
  );

  return new ApiResponse(200, "Review unhidden successfully", review.toJSON());
};

/* ── Admin: Remove Review ── */

export const adminRemoveReviewService = async (
  reviewId: string,
  _data: IAdminReviewActionRequest
) => {
  const review = await Review.findById(reviewId);
  if (!review) {
    throw new ApiError(404, "Review not found");
  }

  if (review.status === "removed") {
    throw new ApiError(400, "Review is already removed");
  }

  review.status = "removed";
  await review.save();

  await recalcTutorRating(review.tutorId.toString());

  // Notify student that their review was permanently removed
  createNotification({
    userId: review.studentId,
    type: "review_hidden",
    title: "Your Review Has Been Removed",
    message: `An administrator has removed your ${review.rating}-star review. If you believe this is an error, please contact support.`,
    data: {
      reviewId: review._id.toString(),
      rating: review.rating,
      action: "removed",
    },
  }).catch((err) =>
    console.error("Error creating review removed notification:", err)
  );

  return new ApiResponse(200, "Review removed successfully", review.toJSON());
};

/* ── Admin: Restore Review ── */

export const adminRestoreReviewService = async (
  reviewId: string,
  _data: IAdminReviewActionRequest
) => {
  const review = await Review.findById(reviewId);
  if (!review) {
    throw new ApiError(404, "Review not found");
  }

  if (review.status !== "removed") {
    throw new ApiError(400, "Review is not removed");
  }

  review.status = "published";
  await review.save();

  await recalcTutorRating(review.tutorId.toString());

  // Notify student that their removed review was restored
  createNotification({
    userId: review.studentId,
    type: "review_restored",
    title: "Your Review Has Been Restored",
    message: `Your previously removed ${review.rating}-star review has been restored and is now visible again.`,
    data: {
      reviewId: review._id.toString(),
      rating: review.rating,
      action: "restored_from_removed",
    },
  }).catch((err) =>
    console.error("Error creating review restored notification:", err)
  );

  return new ApiResponse(200, "Review restored successfully", review.toJSON());
};

/* ── Admin: Handle Report ── */

export const adminHandleReportService = async (
  reviewId: string,
  reportId: string,
  data: IAdminReportActionRequest
) => {
  const review = await Review.findById(reviewId);
  if (!review) {
    throw new ApiError(404, "Review not found");
  }

  const report = review.reports.find(
    (r: any) => r._id?.toString() === reportId
  );
  if (!report) {
    throw new ApiError(404, "Report not found");
  }

  report.status = data.status;
  report.reviewedAt = new Date();

  // If all reports are resolved, update the reported flag
  const hasPending = review.reports.some((r) => r.status === "pending");
  if (!hasPending) {
    review.reported = false;
  }

  await review.save();

  return new ApiResponse(200, "Report handled successfully", review.toJSON());
};
