import { hashUserEmail } from '@deeplib/data';
import { UserModel } from '@deeplib/db';
import { w3cEmailRegex } from '@stdlib/misc';
import { TRPCError } from '@trpc/server';
import { once } from 'lodash';
import { sendMail } from 'src/mail';
import type { InferProcedureOpts } from 'src/trpc/helpers';
import { publicProcedure } from 'src/trpc/helpers';
import { derivePasswordValues } from 'src/utils/crypto';
import { registerUser, userRegistrationSchema } from 'src/utils/users';
import { z } from 'zod';

const baseProcedure = publicProcedure.input(
  z
    .object({
      email: z
        .string()
        .regex(w3cEmailRegex)
        .transform((email) => email.toLowerCase()),
      loginHash: z.instanceof(Uint8Array),
    })
    .merge(userRegistrationSchema()),
);

export const registerProcedure = once(() => baseProcedure.mutation(register));

export async function register({
  ctx,
  input,
}: InferProcedureOpts<typeof baseProcedure>) {
  return await ctx.dataAbstraction.transaction(async (dtrx) => {
    // Get user

    let user = await UserModel.query()
      .where('email_hash', Buffer.from(hashUserEmail(input.email)))
      .where((builder) =>
        builder
          .where('email_verified', true)
          .orWhere('email_verification_expiration_date', '>', new Date()),
      )
      .select('email_verified', 'email_verification_code')
      .first();

    // Check if user already exists

    if (user != null) {
      // User already exists, check if email is verified

      if (user.email_verified) {
        throw new TRPCError({
          message: 'Email already registered.',
          code: 'CONFLICT',
        });
      } else {
        await sendRegistrationEmail({
          email: input.email,
          emailVerificationCode: user.email_verification_code,
        });

        throw new TRPCError({
          message: 'Email awaiting verification. New email sent.',
          code: 'UNAUTHORIZED',
        });
      }
    }

    // Create user

    user = await registerUser({
      ...input,

      ip: ctx.req.ip,
      userAgent: ctx.req.headers['user-agent'] ?? '',

      passwordValues: derivePasswordValues({ password: input.loginHash }),

      dtrx,
    });

    // Send email

    await sendRegistrationEmail({
      email: input.email,
      emailVerificationCode: user.email_verification_code,
    });
  });
}

export async function sendRegistrationEmail(input: {
  email: string;
  emailVerificationCode: string | null;
}) {
  await sendMail({
    from: {
      name: 'DeepNotes',
      email: 'account@deepnotes.app',
    },
    to: [input.email],
    subject: 'Complete your registration',
    html: `
      Visit the following link to verify your email address:<br/>
      <a href="https://deepnotes.app/verify-email/${input.emailVerificationCode}">https://deepnotes.app/verify-email/${input.emailVerificationCode}</a><br/>
      The link above expires in 1 hour.
    `,
  });
}
