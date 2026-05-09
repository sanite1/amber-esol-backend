import { Types, Document } from "mongoose";
import { IAddress } from "./user.interface";

export type OrgPaymentModel = "invoiced" | "stripe";
export type OrgInvoiceCycle = "monthly" | "quarterly" | "annual";

export interface IOrganisation extends Document {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  contactEmail: string;
  contactName: string;
  phoneNumber?: string;
  address?: IAddress;
  logoUrl?: string;
  contractStart?: Date;
  contractEnd?: Date;
  paymentModel: OrgPaymentModel;
  invoiceCycle: OrgInvoiceCycle;
  maxLearners?: number;
  isActive: boolean;
  adminUserId: Types.ObjectId;
  referralCode?: string;
  ilrProviderRef?: string;
  createdAt: Date;
  updatedAt: Date;
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
