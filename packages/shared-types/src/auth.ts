import { z } from 'zod';
import { UserRole } from './common.js';

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email('Enter a valid email address');

/**
 * Password policy. Kept modest on purpose: long passphrases are encouraged,
 * composition rules are not required beyond a floor.
 */
export const PasswordSchema = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(200, 'Password is too long');

export const SignupRequestSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  displayName: z.string().trim().min(1).max(80).optional(),
});
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

export const LoginRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const PasswordResetRequestSchema = z.object({ email: EmailSchema });
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;

export const SessionUserSchema = z.object({
  uid: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  emailVerified: z.boolean(),
  role: UserRole,
  createdAt: z.string(),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const AuthSessionSchema = z.object({
  user: SessionUserSchema,
  /** Which driver produced this session. Surfaced so the UI can label dev auth. */
  driver: z.enum(['firebase', 'local']),
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

export const UpdateProfileRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
});
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;
