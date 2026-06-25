import "server-only";

import type { OwnerId } from "@/lib/repositories";
import { createChannelAccountRepository } from "@/lib/repositories/channel-accounts.server";
import { workerTransaction } from "@/lib/server/db/transaction.server";
import { handleOwnerCommand } from "./command-service.server";
import type { CommandEvent, CommandResponse } from "./types";

type MockInboundBody = Record<string, unknown>;

export type MockInboundResult =
  | {
      readonly status: 400 | 501;
      readonly body: {
        readonly code: "invalid_request" | "not_configured";
        readonly detail: string;
      };
    }
  | {
      readonly status: 200;
      readonly body: MockInboundResponse;
    };

export type MockInboundResponse =
  | {
      readonly status: "needs_link";
      readonly intent: "unknown";
      readonly text: string;
      readonly code: "needs_link";
      readonly reviewUrl: string;
    }
  | (CommandResponse & {
      /**
       * Dev/mock-only proof that provider identity resolved to an owner.
       * Real provider routes must not echo internal owner ids.
       */
      readonly ownerId: string;
    });

const LINK_NEEDED_TEXT =
  "Link this channel in ReMaster before I can help from here.";

export async function handleMockInboundCommand(
  input: unknown,
): Promise<MockInboundResult> {
  if (dataSource() !== "db") {
    return {
      status: 501,
      body: {
        code: "not_configured",
        detail:
          "Mock inbound channel identity resolution requires KEEPSAKE_DATA_SOURCE=db.",
      },
    };
  }

  if (!input || typeof input !== "object") {
    return invalid("body must be an object");
  }

  const body = input as MockInboundBody;
  const externalUserId = stringOrNull(body.externalUserId)?.trim() ?? "";
  if (!externalUserId) {
    return invalid("externalUserId is required");
  }

  const text = stringOrNull(body.text)?.trim() ?? "";
  if (!text) {
    return invalid("text is required");
  }

  const account = await workerTransaction((tx) =>
    createChannelAccountRepository().findByProviderUser(
      "mock",
      externalUserId,
      tx,
    ),
  );

  if (!account || account.status === "revoked") {
    return {
      status: 200,
      body: {
        status: "needs_link",
        intent: "unknown",
        code: "needs_link",
        text: LINK_NEEDED_TEXT,
        reviewUrl: "/profile#command-channels",
      },
    };
  }

  const event: CommandEvent = {
    provider: "mock",
    externalUserId,
    externalThreadId:
      stringOrNull(body.externalThreadId) ?? account.externalThreadId,
    text,
    receivedAtISO: new Date().toISOString(),
    raw: body.raw ?? input,
  };

  // P8-E: hand off to the owner-scoped command service. It still calls
  // routeCommandEvent() for intent classification, then (for follow-up
  // queries) enriches the response with real owner-scoped people +
  // upcoming occasions read under `transaction(ownerId, …)`.
  const response = await handleOwnerCommand(account.ownerId as OwnerId, event);
  return {
    status: 200,
    body: {
      ...response,
      ownerId: account.ownerId,
    },
  };
}

function invalid(detail: string): MockInboundResult {
  return {
    status: 400,
    body: { code: "invalid_request", detail },
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function dataSource(): "mock" | "db" {
  return process.env.KEEPSAKE_DATA_SOURCE === "db" ? "db" : "mock";
}
