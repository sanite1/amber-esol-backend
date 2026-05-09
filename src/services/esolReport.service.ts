import ApiError from "../errors/apiError";
import User from "../models/User";
import Organisation from "../models/Organisation";
import Booking from "../models/Booking";

interface IlrRow {
  uln: string;
  surname: string;
  givenNames: string;
  dateOfBirth: string;
  postcode: string;
  esolLevel: string;
  l1Language: string;
  fundingStatus: string;
  hoursDelivered: string;
  sessionsCompleted: string;
  esolOnboardedAt: string;
  providerRef: string;
}

const ILR_HEADERS: { key: keyof IlrRow; label: string }[] = [
  { key: "uln", label: "ULN" },
  { key: "surname", label: "Family Name" },
  { key: "givenNames", label: "Given Names" },
  { key: "dateOfBirth", label: "Date of Birth" },
  { key: "postcode", label: "Postcode" },
  { key: "esolLevel", label: "ESOL Level" },
  { key: "l1Language", label: "First Language" },
  { key: "fundingStatus", label: "Funding Status" },
  { key: "hoursDelivered", label: "Hours Delivered" },
  { key: "sessionsCompleted", label: "Sessions Completed" },
  { key: "esolOnboardedAt", label: "Learning Start Date" },
  { key: "providerRef", label: "Provider Reference (UKPRN)" },
];

const csvEscape = (value: string): string => {
  if (value == null) return "";
  let str = String(value);
  // Neutralise CSV/spreadsheet formula-injection: cells that begin with
  // =, +, -, @, tab, or CR are interpreted as formulas by Excel/Sheets.
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (str.includes(",") || str.includes("\n") || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const formatIsoDate = (d?: Date | string | null): string => {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "";
  return date.toISOString().split("T")[0];
};

const computeHours = (
  startTime: string,
  endTime: string
): number => {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  return Math.max(0, (endMin - startMin) / 60);
};

export interface IlrReport {
  csv: string;
  filename: string;
  rowCount: number;
}

export const generateIlrCsvService = async (params: {
  orgId: string;
  periodStart: string;
  periodEnd: string;
}): Promise<IlrReport> => {
  const org = await Organisation.findById(params.orgId);
  if (!org) {
    throw new ApiError(404, "Organisation not found");
  }

  const periodStart = new Date(params.periodStart);
  const periodEnd = new Date(params.periodEnd);
  if (periodEnd < periodStart) {
    throw new ApiError(400, "Period end must be after period start");
  }

  // Find all learners in this org
  const learners = await User.find({
    role: "student",
    orgId: org._id,
  }).select(
    "firstname lastname email uln dateOfBirth address esolLevel l1Language fundingStatus esolOnboardedAt"
  );

  // Aggregate hours per learner from completed orgInvoiced bookings in the period
  const bookings = await Booking.find({
    orgId: org._id,
    paymentStatus: "orgInvoiced",
    status: "completed",
    completedAt: { $gte: periodStart, $lte: periodEnd },
  }).select("studentId startTime endTime");

  const hoursByLearner: Record<string, { hours: number; sessions: number }> = {};
  for (const b of bookings) {
    const id = b.studentId.toString();
    if (!hoursByLearner[id]) hoursByLearner[id] = { hours: 0, sessions: 0 };
    hoursByLearner[id].hours += computeHours(b.startTime, b.endTime);
    hoursByLearner[id].sessions += 1;
  }

  const rows: IlrRow[] = learners.map((l: any) => {
    const stats = hoursByLearner[l._id.toString()] ?? {
      hours: 0,
      sessions: 0,
    };
    return {
      uln: l.uln ?? "",
      surname: l.lastname ?? "",
      givenNames: l.firstname ?? "",
      dateOfBirth: formatIsoDate(l.dateOfBirth),
      postcode: l.address?.postcode ?? "",
      esolLevel: l.esolLevel ?? "",
      l1Language: l.l1Language ?? "",
      fundingStatus: l.fundingStatus ?? "",
      hoursDelivered: stats.hours.toFixed(2),
      sessionsCompleted: String(stats.sessions),
      esolOnboardedAt: formatIsoDate(l.esolOnboardedAt),
      providerRef: org.ilrProviderRef ?? "",
    };
  });

  // Build CSV
  const headerLine = ILR_HEADERS.map((h) => csvEscape(h.label)).join(",");
  const rowLines = rows.map((row) =>
    ILR_HEADERS.map((h) => csvEscape(row[h.key] ?? "")).join(",")
  );
  const csv = [headerLine, ...rowLines].join("\n");

  const startStr = formatIsoDate(periodStart);
  const endStr = formatIsoDate(periodEnd);
  const filename = `ilr-${org.slug}-${startStr}-to-${endStr}.csv`;

  return {
    csv,
    filename,
    rowCount: rows.length,
  };
};
