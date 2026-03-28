require("dotenv").config();
const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

// Helper functions
function normalizePhone(phone) {
  if (!phone) return "";
  return String(phone).replace(/[^\d+]/g, "").trim();
}

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// -----------------------------
// IMPORTANT
// Stripe webhook needs raw body
// -----------------------------
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {

      const dedupeKey = `stripe:event:${event.id}`; 
      const existingStatus = await redis.get(dedupeKey);

      if (existingStatus === "done") {
        console.log("Duplicate webhook ignored:", event.id);
        return res.json({ received: true, duplicate: true });
      }

      const lockSet = await redis.set(dedupeKey, "processing", {
        nx: true,
        ex: 60 * 10,
      });
      
      if (!lockSet && existingStatus === "processing") {
        console.log("Webhook already processing:", event.id);
        return res.json({ received: true, processing: true });
      }

      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
    
          if (session.mode !== "setup") {
            console.log("Skipping because mode is not setup:", session.mode);
            break;
          }
    
          const setupIntentId = session.setup_intent;
          const ghlContactId = session.metadata?.ghl_contact_id || null;
    
          if (!setupIntentId) {
            console.log("No setup_intent found on session");
            break;
          }
    
          const setupIntent = await stripe.setupIntents.retrieve(setupIntentId, {
            expand: ["payment_method"],
          });
    
          const customerId = setupIntent.customer;
          const paymentMethod = setupIntent.payment_method;
    
          const payload = {
            stripe_customer_id: customerId,
            stripe_payment_method_id: paymentMethod?.id || "",
            stripe_setup_intent_id: setupIntent.id,
            stripe_setup_status: "ready",
            card_brand: paymentMethod?.card?.brand || "",
            card_last4: paymentMethod?.card?.last4 || "",
          };
    
          // console.log("Payload to GHL:", payload);
    
          if (ghlContactId) {
            const result = await updateHighLevelContact(ghlContactId, payload);
            // console.log("GHL update result:", result);
          } else {
            console.log("No ghlContactId found");
          }
    
          break;
        }

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

      await redis.set(dedupeKey, "done", {
        ex: 60 * 60 * 24 * 7,
      });

      res.json({ received: true });
    } catch (err) {
      await redis.del(dedupeKey);
      console.error("Webhook handler failed:", err);
      return res.status(500).json({ error: "Webhook handler failed" });
    }
  }
);

// Regular JSON body parser for non-webhook routes
app.use(express.json());
app.use(cors());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// -----------------------------------------
// HighLevel helpers
// -----------------------------------------
const GHL_FIELD_IDS = {
  stripe_customer_id: "zl9o2FSJeut5quI4z4UU",
  stripe_payment_method_id: "Z9u7mE6qTzni8I4PGiU0",
  stripe_setup_intent_id: "DxMhYXLHxEnHlwg4IWg1",
  stripe_setup_status: "LqydJMr5RIfZ05OXk4zK",
  card_brand: "g2kZc2wNgnzM5KVIf7MG",
  card_last4: "Leij8Xv0A1NBbDmOrRkS",
  last_stripe_payment_intent_id: "6aNCkl3ZuJJvE5pCZpC9",
  last_payment_status: "k13kxkYNv5PQ7yNEcqvl",
  last_payment_error: "5Ge66VN5IDZiFoG1leDd",
  last_payment_amount: "NvyToonoitBveaCF53x8",
  consent_given: "PwovzNGg9Dyka2xYothN",
  consent_timestamp: "XdYUMDdnsESVKGlc6BFr",
  consent_version: "31rCcyJ8Y4fGrH3LPjVz"
};

async function updateHighLevelContact(ghlContactId, fields) {
  const customFields = [];

  for (const [key, value] of Object.entries(fields)) {
    const id = GHL_FIELD_IDS[key];
    if (!id) continue;
    if (value === undefined || value === null) continue;

    customFields.push({
      id,
      value: String(value),
    });
  }

  const response = await fetch(
    `https://services.leadconnectorhq.com/contacts/${ghlContactId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        customFields,
      }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("GHL update failed:", data);
    throw new Error(data.message || "Failed to update GHL contact");
  }

  // console.log("GHL contact updated:", data);
  return data;
}

app.post("/start-card-setup", async (req, res) => {
  try {
    const { name, last_name, email, whatsapp, country_code, consent, consent_text_version } = req.body;

    if (!consent) {
      return res.status(400).json({
        error: "Consent is required before saving card",
      });
    }

    if (!name || !last_name || !email || !whatsapp) {
      return res.status(400).json({
        error: "name, last_name, email, and whatsapp are required",
      });
    }

    const fullPhone = `${country_code || ""}${whatsapp || ""}`;
    const normalizedPhone = normalizePhone(fullPhone);

    // 1) Upsert contact in GHL
    const contact = await upsertHighLevelContact({
      firstName: name,
      lastName: last_name,
      email,
      phone: normalizedPhone,
    });

    const ghlContactId = contact.id;

    if (!ghlContactId) {
      throw new Error("GHL upsert did not return a contact ID");
    }

    // 1.5) Add/update opportunity in pipeline
    try {
      await upsertHighLevelOpportunity({
        contactId: ghlContactId,
        firstName: name,
        lastName: last_name
      });
    } catch (oppErr) {
      console.error("Opportunity creation failed:", oppErr);
    }

    // 2) Try to get existing Stripe customer from GHL
    const contactPaymentData = await getHighLevelContactPaymentData(ghlContactId);
    let customerId = contactPaymentData.stripe_customer_id || null;

    // 3) Create Stripe customer if needed
    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        name: `${name} ${last_name}`.trim(),
        phone: normalizedPhone,
        metadata: {
          ghl_contact_id: ghlContactId,
          source: "gohighlevel",
        },
      });

      customerId = customer.id;
    }

    // 4) Create Stripe Checkout Session
    const consentTimestamp = new Date().toISOString();

    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      customer: customerId,
      currency: "usd",
      locale: "es-419",
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL,
      metadata: {
        ghl_contact_id: ghlContactId,
        source: "gohighlevel",
        purpose: "save_card_for_future_charge",
        consent: "true",
        consent_text_version: consent_text_version || "v1",
	consent_timestamp: consentTimestamp
      },
      setup_intent_data: {
        metadata: {
          ghl_contact_id: ghlContactId,
          source: "gohighlevel",
        },
      },
    });

    // 5) Save Stripe customer immediately in GHL
    await updateHighLevelContact(ghlContactId, {
      stripe_customer_id: customerId,
      stripe_setup_status: "pending",
      consent_given: "true",
      consent_timestamp: consentTimestamp,
      consent_version: consent_text_version || "v1"
    });

    // 6) Redirect to Stripe
    return res.redirect(303, session.url);
  } catch (err) {
    console.error("Error in /start-card-setup:", err);
    return res.status(500).json({
      error: err.message || "Failed to start card setup flow",
    });
  }
});

app.get("/ghl/custom-fields", async (req, res) => {
  try {
    const response = await fetch(
      `https://services.leadconnectorhq.com/locations/${process.env.GHL_LOCATION_ID}/customFields`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.GHL_API_KEY}`,
          Version: "2021-07-28",
          Accept: "application/json",
        },
      }
    );

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Error fetching custom fields:", err);
    res.status(500).json({ error: err.message });
  }
});

async function getHighLevelContactPaymentData(ghlContactId) {
  const response = await fetch(
    `https://services.leadconnectorhq.com/contacts/${ghlContactId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        Version: "2021-07-28",
        Accept: "application/json",
      },
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("Failed to fetch GHL contact:", data);
    throw new Error(data.message || "Failed to fetch GHL contact");
  }

  const contact = data.contact || data;
  const customFields = contact.customFields || [];

  const getFieldValue = (fieldId) => {
    const field = customFields.find((f) => f.id === fieldId);
    return field?.value || null;
  };

  return {
    stripe_customer_id: getFieldValue(GHL_FIELD_IDS.stripe_customer_id),
    stripe_payment_method_id: getFieldValue(GHL_FIELD_IDS.stripe_payment_method_id),
    stripe_setup_status: getFieldValue(GHL_FIELD_IDS.stripe_setup_status),
  };
}

async function upsertHighLevelContact({ firstName, lastName, email, phone }) {
  const response = await fetch(
    "https://services.leadconnectorhq.com/contacts/upsert",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        locationId: process.env.GHL_LOCATION_ID,
        firstName,
        lastName,
        email,
        phone,
      }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("GHL upsert failed:", data);
    throw new Error(data.message || "Failed to upsert GHL contact");
  }

  // console.log("GHL upsert result:", data);

  // Depending on the response shape, adapt this if needed
  const contact = data.contact || data;
  return contact;
}

app.post("/create-payment-checkout-session", async (req, res) => {
  try {
    const {
      customer_id,
      price_id,
      quantity = 1,
      success_url,
      cancel_url,
      client_reference_id,
      metadata = {},
      allow_promotion_codes = false,
      locale,
    } = req.body;

    if (!customer_id) {
      return res.status(400).json({ error: "customer_id is required" });
    }

    if (!price_id) {
      return res.status(400).json({ error: "price_id is required" });
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: "quantity must be an integer >= 1" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customer_id,
      line_items: [
        {
          price: price_id,
          quantity,
        },
      ],
      success_url: success_url || process.env.PAYMENT_SUCCESS_URL,
      cancel_url: cancel_url || process.env.PAYMENT_CANCEL_URL,
      client_reference_id: client_reference_id || undefined,
      metadata,
      allow_promotion_codes,
      locale: locale || undefined,
    });

    return res.json({
      session_id: session.id,
      url: session.url,
    });
  } catch (err) {
    console.error("Error creating payment checkout session:", err);
    return res.status(500).json({
      error: err.message || "Failed to create payment checkout session",
    });
  }
});

app.get("/start-checkout", async (req, res) => {
  try {
    const {
      customer_id,
      contact_id,
      price_id,
      quantity = "1",
      success_url,
      cancel_url,
      locale,
      email,
    } = req.query;

    if (!price_id) {
      return res.status(400).send("Missing price_id");
    }

    const parsedQuantity = parseInt(quantity, 10);
    if (!Number.isInteger(parsedQuantity) || parsedQuantity < 1) {
      return res.status(400).send("quantity must be an integer >= 1");
    }

    const finalSuccessUrl = success_url || process.env.PAYMENT_SUCCESS_URL;
    const finalCancelUrl = cancel_url || process.env.PAYMENT_CANCEL_URL;

    if (!finalSuccessUrl || !finalCancelUrl) {
      return res.status(400).send("Missing success_url or cancel_url");
    }

    const metadata = {
      source: "ghl",
      price_id,
    };

    if (contact_id) {
      metadata.contact_id = String(contact_id);
    }

    const sessionParams = {
      mode: "payment",
      line_items: [
        {
          price: price_id,
          quantity: parsedQuantity,
        },
      ],
      success_url: finalSuccessUrl,
      cancel_url: finalCancelUrl,
      locale: locale || undefined,
      metadata,
    };

    // Best case: existing Stripe customer
    if (customer_id) {
      sessionParams.customer = String(customer_id);

      if (contact_id) {
        sessionParams.client_reference_id = String(contact_id);
      }
    } else {
      // Fallback: still create a valid Checkout Session
      sessionParams.customer_creation = "always";

      // Optional: prefill email if you have it from GHL/URL params
      if (email) {
        sessionParams.customer_email = String(email);
      }

      if (contact_id) {
        sessionParams.client_reference_id = String(contact_id);
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return res.redirect(303, session.url);
  } catch (err) {
    console.error("Error in /start-checkout:", err);
    return res.status(500).send("Failed to create checkout session");
  }
});

async function upsertHighLevelOpportunity({
  contactId,
  firstName,
  lastName,
  source = "custom_form"
}) {
  const response = await fetch(
    "https://services.leadconnectorhq.com/opportunities/upsert",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        locationId: process.env.GHL_LOCATION_ID,
        contactId,
        pipelineId: process.env.GHL_WA_BOT_WEBINAR_PIPELINE_ID,
        pipelineStageId: process.env.GHL_WA_BOT_WEBINAR_NEW_LEAD_STAGE_ID,
        status: process.env.GHL_WA_BOT_WEBINAR_STATUS || "open",
        name:
          `${firstName || ""} ${lastName || ""}`.trim() || "New Lead"
      }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("GHL opportunity upsert failed:", data);
    throw new Error(data.message || "Failed to upsert GHL opportunity");
  }

  return data.opportunity || data;
}

module.exports = app;
