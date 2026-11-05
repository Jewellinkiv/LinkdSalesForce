import { randomUUID } from "node:crypto";
import { db } from "../src/server/db";
import { passwordHash } from "../src/server/auth";
import { createCustomer, changeStage, activity } from "../src/server/domain";
import type { User } from "../src/lib/types";

async function seed() {
  if (process.env.APP_MODE !== "demo") {
    const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
    if (
      !ADMIN_EMAIL ||
      !ADMIN_PASSWORD ||
      ADMIN_PASSWORD.length < 14 ||
      !ADMIN_NAME
    )
      throw new Error(
        "Set ADMIN_EMAIL, ADMIN_NAME and an ADMIN_PASSWORD of at least 14 characters.",
      );
    await db.query(
      "INSERT INTO users(id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,'admin') ON CONFLICT(email) DO NOTHING",
      [
        randomUUID(),
        ADMIN_NAME,
        ADMIN_EMAIL.toLowerCase(),
        passwordHash(ADMIN_PASSWORD),
      ],
    );
    console.log(
      "Administrator bootstrapped. Existing passwords were not changed.",
    );
    return;
  }
  if (Number((await db.query("SELECT count(*) FROM users")).rows[0].count)) {
    console.log("Workspace already initialized. No changes.");
    return;
  }
  const users: User[] = [
    {
      id: randomUUID(),
      name: "Alex Morgan",
      email: "alex@example.test",
      role: "admin",
    },
    {
      id: randomUUID(),
      name: "Jordan Lee",
      email: "jordan@example.test",
      role: "sales",
    },
    {
      id: randomUUID(),
      name: "Taylor Reed",
      email: "taylor@example.test",
      role: "onboarding",
    },
  ];
  for (const u of users)
    await db.query(
      "INSERT INTO users(id,name,email,role) VALUES ($1,$2,$3,$4)",
      [u.id, u.name, u.email, u.role],
    );
  const samples = [
    [
      "Evergreen Jewelers",
      "Avery Brooks",
      "Austin, TX",
      "Full suite",
      899,
      "Decision",
      "Review rollout proposal",
      "Trade show",
    ],
    [
      "Aster & Stone",
      "Jamie Parker",
      "Nashville, TN",
      "Full suite",
      720,
      "Demo scheduled",
      "Walk through the full suite",
      "Website",
    ],
    [
      "Northline Fine Jewelry",
      "Cameron Ellis",
      "Denver, CO",
      "Data & training",
      599,
      "Contacted",
      "Follow up on training goals",
      "Referral",
    ],
    [
      "Linden House",
      "Riley Hayes",
      "Charleston, SC",
      "Training only",
      540,
      "New lead",
      "Introduce the training program",
      "Trade show",
    ],
    [
      "Vale & Co.",
      "Drew Collins",
      "Portland, OR",
      "Full suite",
      1200,
      "Won",
      "Confirm integration requirements",
      "Referral",
    ],
    [
      "Juniper Jewelry",
      "Casey Bennett",
      "Bentonville, AR",
      "Texting",
      350,
      "Won",
      "Verify messaging setup",
      "Website",
    ],
    [
      "Harbor Gem Studio",
      "Morgan Blake",
      "Savannah, GA",
      "Training only",
      540,
      "Won",
      "Schedule manager training",
      "Website",
    ],
    [
      "Cedar & Gold",
      "Quinn West",
      "Scottsdale, AZ",
      "Full suite",
      899,
      "Be back",
      "Reconnect after current contract",
      "Outbound",
    ],
    [
      "Marigold Fine Jewelry",
      "Sam Rivera",
      "Charlotte, NC",
      "Data & training",
      599,
      "Decision",
      "Confirm the launch timeline",
      "Referral",
    ],
    [
      "Oak & Opal",
      "Reese Taylor",
      "Tulsa, OK",
      "Training only",
      540,
      "Contacted",
      "Send training overview",
      "Website",
    ],
    [
      "Meridian Jewelers",
      "Dakota Lane",
      "Raleigh, NC",
      "Full suite",
      899,
      "Lost",
      "Review fit next year",
      "Trade show",
    ],
    [
      "Willow Atelier",
      "Emerson Quinn",
      "Santa Fe, NM",
      "Full suite",
      980,
      "New lead",
      "Reach out about POS migration",
      "Website",
    ],
  ] as const;
  const companyIds: string[] = [];
  for (let i = 0; i < samples.length; i++) {
    const [name, contactName, city, pkg, mrr, stage, nextAction, source] =
      samples[i];
    const owner = users[i % 2];
    const company = await createCustomer(
      {
        name,
        contactName,
        city,
        pos: i % 3 === 0 ? "The Edge" : "Other",
        locations: i % 4 === 0 ? 2 : 1,
        package: pkg,
        mrr,
        email: `contact${i + 1}@example.test`,
        phone: `+120255501${String(i + 10)}`,
        source,
        nextAction,
        nextActionAt: new Date(
          Date.now() + ((i % 4) - 1) * 86400000,
        ).toISOString(),
        smsConsent: true,
        emailConsent: true,
        consentSource: "Fictional demo permission",
      },
      owner,
    );
    companyIds.push(company);
    const opportunity = (
      await db.query("SELECT id FROM opportunities WHERE company_id=$1", [
        company,
      ])
    ).rows[0];
    if (stage !== "New lead")
      await changeStage(
        opportunity.id,
        stage,
        owner,
        stage === "Lost" ? "Budget timing — sample outcome" : "",
      );
    await db.query(
      "UPDATE companies SET created_at=now()-($2::int*interval '1 day') WHERE id=$1",
      [company, 15 - i],
    );
    await db.query(
      "UPDATE opportunities SET next_action=$2,next_action_at=$3 WHERE id=$1 AND stage NOT IN ('Won','Lost')",
      [
        opportunity.id,
        nextAction,
        new Date(Date.now() + ((i % 4) - 1) * 86400000),
      ],
    );
    if (stage === "Won") {
      const phase =
        i === 4
          ? "Intake & pre-build"
          : i === 5
            ? "Working session"
            : "Training";
      await db.query(
        "UPDATE onboarding SET phase=$2,started_at=now()-interval '8 days',target_at=now()+interval '20 days',blocker=$3 WHERE company_id=$1",
        [
          company,
          phase,
          i === 4 ? "Waiting for POS export from the store" : "",
        ],
      );
      const completed =
        i === 4
          ? ["Handoff"]
          : i === 5
            ? ["Handoff", "Intake & pre-build"]
            : ["Handoff", "Intake & pre-build", "Working session"];
      await db.query(
        "UPDATE tasks SET completed_at=now() WHERE company_id=$1 AND phase=ANY($2)",
        [company, completed],
      );
    }
  }
  const ct = (
    await db.query("SELECT * FROM contacts WHERE company_id=$1", [
      companyIds[0],
    ])
  ).rows[0];
  await db.query(
    "INSERT INTO messages(id,company_id,contact_id,user_id,channel,direction,subject,body,recipient,status) VALUES ($1,$2,$3,$4,'email','inbound','Re: Your Linkd walkthrough','Thanks for the walkthrough. Could we review a rollout across both locations next week?', $5,'received')",
    [randomUUID(), companyIds[0], ct.id, users[0].id, users[0].email],
  );
  await db.query(
    "INSERT INTO calls(id,company_id,contact_id,user_id,status,duration,summary,outcome,transcript) VALUES ($1,$2,$3,$4,'demo',438,$5,'Demo completed',$6)",
    [
      randomUUID(),
      companyIds[0],
      ct.id,
      users[0].id,
      "Sample call: interested in a two-location rollout. Main concern is migration timing. Next step is a proposal review.",
      JSON.stringify([
        {
          speaker: "Rep",
          time: 0,
          text: "What would a successful rollout look like for your team?",
        },
        {
          speaker: "Customer",
          time: 8,
          text: "One place for our sales team to see the full customer story, across both locations.",
        },
        {
          speaker: "Rep",
          time: 19,
          text: "We can map the data migration first and then schedule training around your store hours.",
        },
        {
          speaker: "Customer",
          time: 29,
          text: "That sounds good. Send over the proposal and let’s review it next week.",
        },
      ]),
    ],
  );
  await activity(
    db,
    companyIds[0],
    users[0].id,
    "call",
    "Discovery call completed",
    "Sample call · 7 min · Proposal review is the next step.",
  );
  console.log(
    "Fictional demo workspace created. No real customer data or credentials loaded.",
  );
}
seed()
  .then(() => db.end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
