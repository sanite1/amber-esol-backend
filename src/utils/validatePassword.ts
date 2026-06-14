import ApiError from "../errors/apiError";

export const validatePassword = (password: string): void => {
  if (!password || password.length < 8) {
    throw new ApiError(400, "Password must be at least 8 characters long");
  }

  if (!/[A-Z]/.test(password)) {
    throw new ApiError(
      400,
      "Password must contain at least one uppercase letter",
    );
  }

  if (!/[a-z]/.test(password)) {
    throw new ApiError(
      400,
      "Password must contain at least one lowercase letter",
    );
  }

  if (!/[0-9]/.test(password)) {
    throw new ApiError(400, "Password must contain at least one number");
  }

  if (!/[^A-Za-z0-9]/.test(password)) {
    throw new ApiError(
      400,
      "Password must contain at least one special character",
    );
  }
};
