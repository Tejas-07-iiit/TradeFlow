import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import {
  DEFAULT_WALLET_BALANCE,
  DEFAULT_WALLET_CURRENCY,
} from "@/server/wallet";

const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
});

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = registerSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid input",
        issues: parsed.error.flatten().fieldErrors,
      },
      { status: 422 },
    );
  }

  const { name, email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json(
      { error: "An account with this email already exists." },
      { status: 409 },
    );
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  // Atomic: a user without a wallet is an invalid state for this app.
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { name, email, hashedPassword },
      select: { id: true, name: true, email: true },
    });

    await tx.paperWallet.create({
      data: {
        userId: created.id,
        balance: DEFAULT_WALLET_BALANCE,
        currency: DEFAULT_WALLET_CURRENCY,
      },
    });

    return created;
  });

  return NextResponse.json(
    {
      user,
      wallet: {
        balance: DEFAULT_WALLET_BALANCE,
        currency: DEFAULT_WALLET_CURRENCY,
      },
    },
    { status: 201 },
  );
}
