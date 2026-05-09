import { Schema, model } from "mongoose";
import { IOrganisation } from "../interfaces/organisation.interface";

const organisationSchema = new Schema<IOrganisation>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    contactEmail: { type: String, required: true, lowercase: true, trim: true },
    contactName: { type: String, required: true, trim: true },
    phoneNumber: { type: String, trim: true },
    address: {
      street: { type: String },
      city: { type: String },
      state: { type: String },
      postcode: { type: String },
      country: { type: String },
    },
    logoUrl: { type: String },
    contractStart: { type: Date },
    contractEnd: { type: Date },
    paymentModel: {
      type: String,
      enum: ["invoiced", "stripe"],
      required: true,
      default: "invoiced",
    },
    invoiceCycle: {
      type: String,
      enum: ["monthly", "quarterly", "annual"],
      required: true,
      default: "monthly",
    },
    maxLearners: { type: Number },
    isActive: { type: Boolean, default: true },
    adminUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    referralCode: { type: String },
    ilrProviderRef: { type: String },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
      },
    },
  }
);

organisationSchema.index({ slug: 1 }, { unique: true });
organisationSchema.index({ adminUserId: 1 });

const Organisation = model<IOrganisation>("Organisation", organisationSchema);

export default Organisation;
