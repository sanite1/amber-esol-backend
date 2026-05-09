import * as bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import Organisation from "../models/Organisation";
import {
  IProvisionOrgRequest,
  IUpdateOrganisationRequest,
} from "../interfaces/organisation.interface";
import { sendVerificationMail } from "./nodemailer/mail.service";
import { validatePassword } from "../utils/validatePassword";

const SALT_ROUNDS = 13;

const generateSlug = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "-");

/* ── Provision Organisation + Org Admin ── */

export const provisionOrgService = async (data: IProvisionOrgRequest) => {
  const existingUser = await User.findOne({ email: data.adminEmail });
  if (existingUser) {
    throw new ApiError(400, `A user with email ${data.adminEmail} already exists`);
  }

  validatePassword(data.adminPassword);

  const baseSlug = generateSlug(data.name);
  let slug = baseSlug;
  let attempt = 1;
  while (await Organisation.findOne({ slug })) {
    slug = `${baseSlug}-${attempt}`;
    attempt++;
  }

  const hashedPassword = await bcrypt.hash(data.adminPassword, SALT_ROUNDS);
  const verificationToken = randomBytes(32).toString("hex");

  const adminUser = await User.create({
    firstname: data.adminFirstname,
    lastname: data.adminLastname,
    email: data.adminEmail,
    phoneNumber: data.adminPhoneNumber,
    password: hashedPassword,
    verificationToken,
    role: "org_admin",
    status: "unverified",
    verified: false,
    isActive: true,
  });

  const org = await Organisation.create({
    name: data.name,
    slug,
    contactEmail: data.contactEmail,
    contactName: data.contactName,
    phoneNumber: data.phoneNumber,
    address: data.address,
    contractStart: data.contractStart ? new Date(data.contractStart) : undefined,
    contractEnd: data.contractEnd ? new Date(data.contractEnd) : undefined,
    paymentModel: data.paymentModel,
    invoiceCycle: data.invoiceCycle,
    maxLearners: data.maxLearners,
    ilrProviderRef: data.ilrProviderRef,
    isActive: true,
    adminUserId: adminUser._id,
  });

  // Link org back to admin user
  await User.findByIdAndUpdate(adminUser._id, { orgId: org._id });

  await sendVerificationMail(adminUser).catch(() => {});

  return new ApiResponse(201, "Organisation provisioned successfully", {
    organisation: org.toJSON(),
    adminUser: adminUser.toJSON(),
  });
};

/* ── List Organisations ── */

export const listOrgsService = async (options: {
  page?: string;
  limit?: string;
  search?: string;
  isActive?: string;
}) => {
  const page = parseInt(options.page || "1", 10);
  const limit = parseInt(options.limit || "20", 10);
  const skip = (page - 1) * limit;

  const query: any = {};
  if (options.search) {
    const escaped = options.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");
    query.$or = [{ name: regex }, { contactEmail: regex }, { slug: regex }];
  }
  if (options.isActive !== undefined) {
    query.isActive = options.isActive === "true";
  }

  const [orgs, total] = await Promise.all([
    Organisation.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("adminUserId", "firstname lastname email"),
    Organisation.countDocuments(query),
  ]);

  return new ApiResponse(200, "Organisations retrieved successfully", {
    organisations: orgs,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

/* ── Get Organisation ── */

export const getOrgService = async (
  orgId: string,
  callerId: string,
  callerRole: string,
  callerOrgId?: string | null
) => {
  const org = await Organisation.findById(orgId).populate(
    "adminUserId",
    "firstname lastname email"
  );
  if (!org) {
    throw new ApiError(404, "Organisation not found");
  }

  if (callerRole === "org_admin" && callerOrgId !== orgId) {
    throw new ApiError(403, "Access denied to this organisation");
  }

  return new ApiResponse(200, "Organisation retrieved successfully", org.toJSON());
};

/* ── Update Organisation ── */

export const updateOrgService = async (
  orgId: string,
  data: IUpdateOrganisationRequest
) => {
  const updateData: any = { ...data };
  if (data.contractStart) updateData.contractStart = new Date(data.contractStart);
  if (data.contractEnd) updateData.contractEnd = new Date(data.contractEnd);

  const org = await Organisation.findByIdAndUpdate(orgId, updateData, {
    new: true,
    runValidators: true,
  });
  if (!org) {
    throw new ApiError(404, "Organisation not found");
  }

  return new ApiResponse(200, "Organisation updated successfully", org.toJSON());
};

/* ── Update Organisation Status ── */

export const updateOrgStatusService = async (
  orgId: string,
  isActive: boolean
) => {
  const org = await Organisation.findByIdAndUpdate(
    orgId,
    { isActive },
    { new: true }
  );
  if (!org) {
    throw new ApiError(404, "Organisation not found");
  }

  const statusLabel = isActive ? "activated" : "deactivated";
  return new ApiResponse(200, `Organisation ${statusLabel} successfully`, org.toJSON());
};
