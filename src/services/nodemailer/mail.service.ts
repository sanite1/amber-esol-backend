import ApiError from "../../errors/apiError";
import { IUser } from "../../interfaces/user.interface";
import transporter from "./nodemailer";

const DOMAIN_NAME = process.env.DOMAIN_NAME;

export const sendVerificationMail = async (userInfo: IUser) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: userInfo.email,
    template: "./verifyemail",
    subject: "Verify Your Email - Amber Training",
    context: {
      name: userInfo.firstname,
      email: userInfo.email,
      url: `${DOMAIN_NAME}/verify/${userInfo._id}/${userInfo.verificationToken}`,
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    throw new ApiError(500, `Error sending verification email: ${error}`);
  }
};

export const sendForgotPasswordMail = async (userInfo: IUser) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: userInfo.email,
    subject: "Reset Your Password - Amber Training",
    template: "./passwordreset",
    context: {
      name: userInfo.firstname,
      url: `${DOMAIN_NAME}/reset-password/${userInfo._id}/${userInfo.resetToken}`,
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    throw new ApiError(500, `Error sending forgot password mail: ${error}`);
  }
};

export const sendWelcomeMail = async (userInfo: IUser) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: userInfo.email,
    template: "./welcome",
    subject: "Welcome to Amber Training!",
    context: {
      name: userInfo.firstname,
      role: userInfo.role,
      loginUrl: `${DOMAIN_NAME}/login`,
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error("Error sending welcome email:", error);
    // Non-critical, don't throw
  }
};

export const sendAccountSuspendedMail = async (
  userInfo: IUser,
  reason?: string,
  duration?: string
) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: userInfo.email,
    template: "./suspended",
    subject: "Account Suspended - Amber Training",
    context: {
      name: userInfo.firstname,
      reason: reason || "Violation of platform terms",
      duration: duration || "Indefinite",
      supportEmail: process.env.AUTH_EMAIL,
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error("Error sending suspension email:", error);
  }
};

export const sendAccountReactivatedMail = async (userInfo: IUser) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: userInfo.email,
    template: "./reactivated",
    subject: "Account Reactivated - Amber Training",
    context: {
      name: userInfo.firstname,
      loginUrl: `${DOMAIN_NAME}/login`,
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error("Error sending reactivation email:", error);
  }
};

export const sendAccountDeletedMail = async (user: IUser) => {
  const mailOptions = {
    from: `"Unimerg" <${process.env.AUTH_EMAIL}>`,
    to: user.email,
    subject: "Account Deleted - Unimerg",
    template: "./accountDeleted",
    context: {
      firstname: user.firstname,
      lastname: user.lastname,
      email: user.email,
      deletionDate: new Date().toLocaleDateString("en-GB", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
      supportEmail: process.env.SUPPORT_EMAIL || "support@ambertraining.co.uk",
      reactivateUrl: `${process.env.DOMAIN_NAME}/help`,
      currentYear: new Date().getFullYear(),
    },
  };

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error("Error sending account deleted email:", error);
  }
};
