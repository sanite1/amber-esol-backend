import { Types, Document } from "mongoose";
import { IAddress } from "./user.interface";

export type OrgPaymentModel = "invoiced" | "stripe";
export type OrgInvoiceCycle = "monthly" | "quarterly" | "annual";
export type OrgType = "college" | "council" | "charity" | "employer";
export type MisType = "ProSolution" | "Maytas" | "EBS" | "none";

export interface IOrganisation extends Document {
  _id: Types.ObjectId;
  // Existing camelCase fields (contactEmail/contactName/adminUserId are
  // optional at schema level — brief Function 1 may create orgs before
  // the org_admin user exists).
  name: string;
  slug: string;
  contactEmail?: string | null;
  contactName?: string | null;
  phoneNumber?: string;
  address?: IAddress;
  logoUrl?: string;
  contractStart?: Date;
  contractEnd?: Date;
  paymentModel: OrgPaymentModel;
  invoiceCycle: OrgInvoiceCycle;
  maxLearners?: number;
  isActive: boolean;
  adminUserId?: Types.ObjectId | null;
  referralCode?: string;
  ilrProviderRef?: string;
  createdAt: Date;
  updatedAt: Date;

  // Brief Phase 1.8 fields (snake_case)
  type?: OrgType | null;
  monthly_fee_per_head?: number | null;
  esol_session_rate?: number | null;
  reporting_contact_email?: string | null;
  billing_active?: boolean;
  is_demo?: boolean;
  is_employer?: boolean;
  notes?: string | null;
  created_by?: Types.ObjectId | null;

  // Addendum §4 teacher-multiplier
  assigned_teacher_ids?: Types.ObjectId[];
  max_learners_per_teacher?: number;

  // Addendum §21 MIS integration (credentials encrypted at rest)
  misType?: MisType;
  misApiEndpoint?: string | null;
  misApiCredentials?: string | null;
}

export interface ICreateOrganisationRequest {
  name: string;
  contactEmail: string;
  contactName: string;
  phoneNumber?: string;
  address?: IAddress;
  logoUrl?: string;
  contractStart?: string;
  contractEnd?: string;
  paymentModel: OrgPaymentModel;
  invoiceCycle: OrgInvoiceCycle;
  maxLearners?: number;
  adminUserId: string;
  ilrProviderRef?: string;
}

export interface IProvisionOrgRequest {
  // Organisation data
  name: string;
  contactEmail: string;
  contactName: string;
  phoneNumber?: string;
  address?: IAddress;
  contractStart?: string;
  contractEnd?: string;
  paymentModel: OrgPaymentModel;
  invoiceCycle: OrgInvoiceCycle;
  maxLearners?: number;
  ilrProviderRef?: string;
  // Org admin user data
  adminFirstname: string;
  adminLastname: string;
  adminEmail: string;
  adminPhoneNumber: string;
  adminPassword: string;
}

export interface IUpdateOrganisationRequest {
  name?: string;
  contactEmail?: string;
  contactName?: string;
  phoneNumber?: string;
  address?: IAddress;
  logoUrl?: string;
  contractStart?: string;
  contractEnd?: string;
  paymentModel?: OrgPaymentModel;
  invoiceCycle?: OrgInvoiceCycle;
  maxLearners?: number;
  ilrProviderRef?: string;
  isActive?: boolean;
}
