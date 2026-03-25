require("dotenv").config();
const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

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

    console.log("Webhook event type:", event.type);
    console.log("Webhook event id:", event.id);

    try {

      const dedupeKey = `stripe:event:${event.id}`; 

      const wasSet = await redis.set(dedupeKey, "1", {
        nx: true,
        ex: 60 * 60 * 24 * 7, // 7 days
      });
      
      if (!wasSet) {
        console.log("Duplicate webhook ignored:", event.id);
        return res.json({ received: true, duplicate: true });
      }

      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          console.log("Session object:", JSON.stringify(session, null, 2));
    
          if (session.mode !== "setup") {
            console.log("Skipping because mode is not setup:", session.mode);
            break;
          }
    
          const setupIntentId = session.setup_intent;
          const ghlContactId = session.metadata?.ghl_contact_id || null;
    
          console.log("setupIntentId:", setupIntentId);
          console.log("ghlContactId:", ghlContactId);
    
          if (!setupIntentId) {
            console.log("No setup_intent found on session");
            break;
          }
    
          const setupIntent = await stripe.setupIntents.retrieve(setupIntentId, {
            expand: ["payment_method"],
          });
    
          console.log("Retrieved setupIntent:", JSON.stringify(setupIntent, null, 2));
    
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
    
          console.log("Payload to GHL:", payload);
    
          if (ghlContactId) {
            const result = await updateHighLevelContact(ghlContactId, payload);
            console.log("GHL update result:", result);
          } else {
            console.log("No ghlContactId found");
          }
    
          break;
        }

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

      res.json({ received: true });
    } catch (err) {
      console.error("Webhook handler failed:", err);
      res.status(500).json({ error: "Webhook handler failed" });
    }
  }
);

// Regular JSON body parser for non-webhook routes
app.use(express.json());
app.use(cors());

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// -----------------------------------------
// 1) Create Checkout Session in setup mode
// -----------------------------------------
app.post("/create-card-setup-session", async (req, res) => {
  try {
    const {
      ghl_contact_id,
      email,
      name,
      stripe_customer_id,
      consent,
      consent_text_version,
    } = req.body;

    if (!ghl_contact_id) {
      return res.status(400).json({ error: "ghl_contact_id is required" });
    }

    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    if (!consent) {
      return res.status(400).json({
        error: "Explicit consent is required before saving card for later charges",
      });
    }

    let customerId = stripe_customer_id;

    // Create customer if we don't already have one
    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        name,
        metadata: {
          ghl_contact_id,
        },
      });

      customerId = customer.id;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      customer: customerId,
      currency: "usd",
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL,
      metadata: {
        ghl_contact_id,
        source: "gohighlevel",
        purpose: "save_card_for_future_charge",
        consent: "true",
        consent_text_version: consent_text_version || "v1",
      },
      setup_intent_data: {
        metadata: {
          ghl_contact_id,
          source: "gohighlevel",
        },
      },
    });

    // Optional: save the Stripe customer ID immediately into GHL
    await updateHighLevelContact(ghl_contact_id, {
      stripe_customer_id: customerId,
      stripe_setup_status: "pending",
    });

    return res.json({
      url: session.url,
      session_id: session.id,
      stripe_customer_id: customerId,
    });
  } catch (err) {
    console.error("Error creating setup session:", err);
    return res.status(500).json({
      error: err.message || "Failed to create setup session",
    });
  }
});

// -----------------------------------------
// 2) Charge saved card later
// -----------------------------------------
app.post("/charge-saved-card", async (req, res) => {
  try {
    const {
      ghl_contact_id,
      amount,
      currency = "mxn",
      stripe_customer_id,
      stripe_payment_method_id,
      description,
      metadata = {},
    } = req.body;

    if (!amount || !Number.isInteger(amount)) {
      return res.status(400).json({
        error: "amount is required and must be an integer in cents",
      });
    }

    let customerId = stripe_customer_id || null;
    let paymentMethodId = stripe_payment_method_id || null;

    if ((!customerId || !paymentMethodId) && ghl_contact_id) {
      const contactData = await getHighLevelContactPaymentData(ghl_contact_id);

      customerId = customerId || contactData.stripe_customer_id;
      paymentMethodId = paymentMethodId || contactData.stripe_payment_method_id;

      if (contactData.stripe_setup_status !== "ready") {
        return res.status(400).json({
          success: false,
          error: "Saved payment method is not marked as ready",
        });
      }
    }

    if (!customerId || !paymentMethodId) {
      return res.status(400).json({
        success: false,
        error: "Missing stripe_customer_id or stripe_payment_method_id",
      });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      customer: customerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      description: description || "Off-session charge from saved card",
      metadata: {
        ghl_contact_id: ghl_contact_id || "",
        source: "gohighlevel",
        ...metadata,
      },
    });

    if (ghl_contact_id) {
      await updateHighLevelContact(ghl_contact_id, {
        last_stripe_payment_intent_id: paymentIntent.id,
        last_payment_status: paymentIntent.status,
        last_payment_error: "",
        last_payment_amount: String(amount),
      });
    }

    return res.json({
      success: true,
      payment_intent_id: paymentIntent.id,
      status: paymentIntent.status,
    });
  } catch (err) {
    console.error("Charge failed:", err);

    const message =
      err?.raw?.message || err?.message || "Failed to charge saved card";

    const ghlContactId = req.body?.ghl_contact_id;

    if (ghlContactId) {
      try {
        await updateHighLevelContact(ghlContactId, {
          last_payment_status: "failed",
          last_payment_error: message,
        });
      } catch (updateErr) {
        console.error("Failed to update GHL after payment failure:", updateErr);
      }
    }

    return res.status(400).json({
      success: false,
      error: message,
      type: err?.type || null,
      code: err?.code || null,
      payment_intent_id: err?.payment_intent?.id || null,
    });
  }
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

  console.log("GHL contact updated:", data);
  return data;
}
async function getHighLevelContactPaymentData(ghlContactId) {
  // Replace this with real HighLevel contact fetch logic
  console.log("Pretend fetching GHL contact payment data:", ghlContactId);

  return {
    stripe_customer_id: null,
    stripe_payment_method_id: null,
  };
}

app.get("/start-card-setup", async (req, res) => {
  try {
    const { ghl_contact_id, email, name, stripe_customer_id } = req.query;

    if (!ghl_contact_id || !email) {
      return res.status(400).send("Missing ghl_contact_id or email");
    }

    let customerId = stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        name: name || "",
        metadata: { ghl_contact_id },
      });

      customerId = customer.id;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      customer: customerId,
      currency: "usd",
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL,
      metadata: {
        ghl_contact_id,
        source: "gohighlevel",
        purpose: "save_card_for_future_charge",
        consent: "true",
        consent_text_version: "v1",
      },
      setup_intent_data: {
        metadata: {
          ghl_contact_id,
          source: "gohighlevel",
        },
      },
    });

    await updateHighLevelContact(ghl_contact_id, {
      stripe_customer_id: customerId,
      stripe_setup_status: "pending",
    });

    return res.redirect(session.url);
  } catch (err) {
    console.error("Error in /start-card-setup:", err);
    return res.status(500).send("Failed to create setup session");
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

  const customFields = data.contact?.customFields || [];

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

app.get("/debug-redis", async (req, res) => {
  const key = "debug:test";
  const before = await redis.get(key);
  const set1 = await redis.set(key, "1", { nx: true, ex: 300 });
  const after = await redis.get(key);
  const set2 = await redis.set(key, "1", { nx: true, ex: 300 });

  res.json({ before, set1, after, set2 });
});

module.exports = app;
