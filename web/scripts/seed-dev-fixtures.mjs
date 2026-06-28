import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = normalize(join(__dirname, ".."));

const defaultOwnerId = "00000000-0000-4000-8000-000000000001";
const ownerId = process.env.DEV_OWNER_ID || defaultOwnerId;
const ownerEmail = process.env.DEV_OWNER_EMAIL || "arthur@example.test";
const ownerName = process.env.DEV_OWNER_NAME || "Arthur";

const personIds = {
  "p-lin": "10000000-0000-4000-8000-000000000001",
  "p-mom": "10000000-0000-4000-8000-000000000002",
  "p-aisha": "10000000-0000-4000-8000-000000000003",
  "p-dad": "10000000-0000-4000-8000-000000000004",
  "p-kira": "10000000-0000-4000-8000-000000000005",
};

const occasionIds = {
  "occ-lin-anniv": "20000000-0000-4000-8000-000000000001",
  "occ-lin-bday": "20000000-0000-4000-8000-000000000002",
  "occ-mom-bday": "20000000-0000-4000-8000-000000000003",
  "occ-mom-lny": "20000000-0000-4000-8000-000000000004",
  "occ-aisha-raya": "20000000-0000-4000-8000-000000000005",
  "occ-aisha-bday": "20000000-0000-4000-8000-000000000006",
  "occ-dad-bday": "20000000-0000-4000-8000-000000000007",
};

const deliveryIds = {
  "d-1": "30000000-0000-4000-8000-000000000001",
  "d-2": "30000000-0000-4000-8000-000000000002",
  "d-3": "30000000-0000-4000-8000-000000000003",
  "d-4": "30000000-0000-4000-8000-000000000004",
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ensureEnv() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required.");
  }
  if (!process.env.DEV_ENCRYPTION_KEY_BASE64) {
    throw new Error("DEV_ENCRYPTION_KEY_BASE64 is required.");
  }
  if (!uuidPattern.test(ownerId)) {
    throw new Error("DEV_OWNER_ID must be a valid UUID.");
  }
}

function transpile(sourcePath, source) {
  return ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

async function loadFixtureModules() {
  const tempRoot = join(projectRoot, ".next", "seed-dev-fixtures");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "run-"));

  const mockSourcePath = join(projectRoot, "lib/mock.ts");
  const mockOutputPath = join(tempDir, "mock.cjs");
  await writeFile(mockOutputPath, transpile(mockSourcePath, await readFile(mockSourcePath, "utf8")));

  const envelopeSourcePath = join(projectRoot, "lib/server/crypto/envelope.server.ts");
  const envelopeSource = (await readFile(envelopeSourcePath, "utf8"))
    .replace(/^import "server-only";\n/, "");
  const envelopeOutputPath = join(tempDir, "envelope.server.cjs");
  await writeFile(envelopeOutputPath, transpile(envelopeSourcePath, envelopeSource));

  const require = createRequire(import.meta.url);
  const mock = require(mockOutputPath);
  const envelope = require(envelopeOutputPath);

  if (!Array.isArray(mock.people) || !Array.isArray(mock.occasions) || !Array.isArray(mock.deliveries)) {
    throw new Error("lib/mock.ts did not expose people, occasions, and deliveries arrays.");
  }
  if (typeof envelope.encrypt !== "function") {
    throw new Error("envelope.server.ts did not expose encrypt().");
  }

  return {
    cleanup: () => rm(tempDir, { force: true, recursive: true }),
    encrypt: envelope.encrypt,
    mock,
  };
}

async function encryptedText(encrypt, table, column, value) {
  if (value === null || value === undefined) {
    return null;
  }

  return Buffer.from(await encrypt(ownerId, table, column, Buffer.from(value, "utf8")));
}

async function encryptedJson(encrypt, table, column, value) {
  return encryptedText(encrypt, table, column, JSON.stringify(value));
}

function fixturePersonId(mockPersonId) {
  const id = personIds[mockPersonId];
  if (!id) {
    throw new Error(`No fixture UUID mapped for mock person ${mockPersonId}.`);
  }
  return id;
}

function fixtureOccasionId(mockOccasionId) {
  const id = occasionIds[mockOccasionId];
  if (!id) {
    throw new Error(`No fixture UUID mapped for mock occasion ${mockOccasionId}.`);
  }
  return id;
}

function fixtureDeliveryId(mockDeliveryId) {
  const id = deliveryIds[mockDeliveryId];
  if (!id) {
    throw new Error(`No fixture UUID mapped for mock delivery ${mockDeliveryId}.`);
  }
  return id;
}

async function seedUser(client) {
  await client.query(
    `
      INSERT INTO users (id, email, display_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE
      SET
        email = EXCLUDED.email,
        display_name = EXCLUDED.display_name,
        updated_at = now()
    `,
    [ownerId, ownerEmail, ownerName],
  );
}

async function seedPeople(client, encrypt, people) {
  for (const person of people) {
    await client.query(
      `
        INSERT INTO people (
          id,
          owner_id,
          name_enc,
          segment,
          organization_enc,
          role_title_enc,
          source_context_enc,
          starred,
          avatar_bg,
          avatar_fg,
          relationship_id,
          culture_id,
          since_enc,
          identity_tags_enc,
          known_facts_enc,
          personal_taboos_enc,
          last_contact_at,
          next_follow_up_at,
          archived_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        ON CONFLICT (id) DO UPDATE
        SET
          owner_id = EXCLUDED.owner_id,
          name_enc = EXCLUDED.name_enc,
          segment = EXCLUDED.segment,
          organization_enc = EXCLUDED.organization_enc,
          role_title_enc = EXCLUDED.role_title_enc,
          source_context_enc = EXCLUDED.source_context_enc,
          starred = EXCLUDED.starred,
          avatar_bg = EXCLUDED.avatar_bg,
          avatar_fg = EXCLUDED.avatar_fg,
          relationship_id = EXCLUDED.relationship_id,
          culture_id = EXCLUDED.culture_id,
          since_enc = EXCLUDED.since_enc,
          identity_tags_enc = EXCLUDED.identity_tags_enc,
          known_facts_enc = EXCLUDED.known_facts_enc,
          personal_taboos_enc = EXCLUDED.personal_taboos_enc,
          last_contact_at = EXCLUDED.last_contact_at,
          next_follow_up_at = EXCLUDED.next_follow_up_at,
          archived_at = EXCLUDED.archived_at,
          updated_at = now()
      `,
      [
        fixturePersonId(person.id),
        ownerId,
        await encryptedText(encrypt, "people", "name_enc", person.name),
        person.segment ?? "personal",
        await encryptedText(encrypt, "people", "organization_enc", person.organization),
        await encryptedText(encrypt, "people", "role_title_enc", person.roleTitle),
        await encryptedText(encrypt, "people", "source_context_enc", person.sourceContext),
        person.starred,
        person.avatarBg,
        person.avatarFg,
        person.relationshipId,
        person.cultureId,
        await encryptedText(encrypt, "people", "since_enc", person.since),
        await encryptedJson(encrypt, "people", "identity_tags_enc", person.identityTags),
        await encryptedJson(encrypt, "people", "known_facts_enc", person.knownFacts),
        await encryptedJson(encrypt, "people", "personal_taboos_enc", person.personalTaboos),
        person.lastContactAt ?? null,
        person.nextFollowUpAt ?? null,
        person.archivedAt ?? null,
      ],
    );
  }
}

async function seedOccasions(client, encrypt, occasions) {
  for (const occasion of occasions) {
    await client.query(
      `
        INSERT INTO occasion_nodes (
          id,
          owner_id,
          person_id,
          kind,
          label_enc,
          detail_enc,
          date_iso,
          recurrence
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'yearly')
        ON CONFLICT (id) DO UPDATE
        SET
          owner_id = EXCLUDED.owner_id,
          person_id = EXCLUDED.person_id,
          kind = EXCLUDED.kind,
          label_enc = EXCLUDED.label_enc,
          detail_enc = EXCLUDED.detail_enc,
          date_iso = EXCLUDED.date_iso,
          recurrence = EXCLUDED.recurrence,
          updated_at = now()
      `,
      [
        fixtureOccasionId(occasion.id),
        ownerId,
        fixturePersonId(occasion.personId),
        occasion.kind,
        await encryptedText(encrypt, "occasion_nodes", "label_enc", occasion.label),
        await encryptedText(encrypt, "occasion_nodes", "detail_enc", occasion.detail),
        occasion.dateISO,
      ],
    );
  }
}

async function seedDeliveries(client, encrypt, deliveries) {
  for (const delivery of deliveries) {
    const personId = personIds[delivery.personId] ?? null;

    await client.query(
      `
        INSERT INTO deliveries (
          id,
          owner_id,
          person_id,
          draft_id,
          recipient_name_enc,
          recipient_email_enc,
          recipient_address_enc,
          occasion_kind,
          occasion_label_enc,
          channel,
          scheduled_for,
          sent_at,
          status,
          provider_message_id
        )
        VALUES ($1, $2, $3, NULL, $4, NULL, NULL, $5, $6, $7, NULL, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE
        SET
          owner_id = EXCLUDED.owner_id,
          person_id = EXCLUDED.person_id,
          recipient_name_enc = EXCLUDED.recipient_name_enc,
          occasion_kind = EXCLUDED.occasion_kind,
          occasion_label_enc = EXCLUDED.occasion_label_enc,
          channel = EXCLUDED.channel,
          sent_at = EXCLUDED.sent_at,
          status = EXCLUDED.status,
          provider_message_id = EXCLUDED.provider_message_id,
          updated_at = now()
      `,
      [
        fixtureDeliveryId(delivery.id),
        ownerId,
        personId,
        await encryptedText(encrypt, "deliveries", "recipient_name_enc", delivery.recipientName),
        delivery.occasionKind,
        await encryptedText(encrypt, "deliveries", "occasion_label_enc", delivery.occasionLabel),
        delivery.channel,
        `${delivery.sentAtISO}T12:00:00.000Z`,
        delivery.status,
        `dev-fixture:${delivery.id}`,
      ],
    );
  }
}

async function main() {
  ensureEnv();

  const { cleanup, encrypt, mock } = await loadFixtureModules();
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();
    await client.query("BEGIN");
    await seedUser(client);
    await seedPeople(client, encrypt, mock.people);
    await seedOccasions(client, encrypt, mock.occasions);
    await seedDeliveries(client, encrypt, mock.deliveries);
    await client.query("COMMIT");

    process.stdout.write(`seeded local dev owner ${ownerId} (${ownerEmail})\n`);
    process.stdout.write(`seeded ${mock.people.length} people, ${mock.occasions.length} occasions, ${mock.deliveries.length} deliveries\n`);
    process.stdout.write("catalog rows are not seeded here; run db/seed_catalog.sql first\n");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
    await cleanup().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
