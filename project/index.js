// Test
require("dotenv").config();
const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const GHL_API_BASE_URL = "https://services.leadconnectorhq.com";
const NETWORK_RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

// Helper functions
function normalizePhone(phone) {
  if (!phone) return "";
  return String(phone).replace(/[^\d+]/g, "").trim();
}

function formatStripeAmount(amount, currency) {
  if (amount === undefined || amount === null) return "";
  return String(amount); // store raw minor-unit value in GHL
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNetworkError(err) {
  return NETWORK_RETRYABLE_ERROR_CODES.has(err?.cause?.code) ||
    NETWORK_RETRYABLE_ERROR_CODES.has(err?.code);
}

function serializeError(err) {
  if (!err) {
    return null;
  }

  return {
    name: err.name || null,
    message: err.message || null,
    code: err.code || null,
    status: err.status || null,
    stack: err.stack || null,
    cause: err.cause ? {
      name: err.cause.name || null,
      message: err.cause.message || null,
      code: err.cause.code || null,
      stack: err.cause.stack || null,
    } : null,
    data: err.data || null,
  };
}

function getEntryPointOpportunityConfig(entryPoint) {
  const normalizedEntryPoint = String(entryPoint || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");

  const configs = {
    pay_later: {
      pipelineStageId:
        process.env.GHL_WA_BOT_WEBINAR_PAY_LATER_ENTRY_STAGE_ID ||
        process.env.GHL_WA_BOT_WEBINAR_NEW_LEAD_STAGE_ID,
      source: "landing_pay_later",
    },
    pay_now: {
      pipelineStageId:
        process.env.GHL_WA_BOT_WEBINAR_PAY_NOW_ENTRY_STAGE_ID ||
        process.env.GHL_WA_BOT_WEBINAR_NEW_LEAD_STAGE_ID,
      source: "landing_pay_now",
    },
  };

  return configs[normalizedEntryPoint] || {
    pipelineStageId: process.env.GHL_WA_BOT_WEBINAR_NEW_LEAD_STAGE_ID,
    source: "custom_form",
  };
}

async function safeRedisGet(key) {
  try {
    return await redis.get(key);
  } catch (err) {
    console.error("Redis get failed", {
      key,
      error: serializeError(err),
    });
    return null;
  }
}

async function safeRedisSet(key, value, options) {
  try {
    return await redis.set(key, value, options);
  } catch (err) {
    console.error("Redis set failed", {
      key,
      value,
      options,
      error: serializeError(err),
    });
    return null;
  }
}

async function safeRedisDel(key) {
  try {
    return await redis.del(key);
  } catch (err) {
    console.error("Redis del failed", {
      key,
      error: serializeError(err),
    });
    return null;
  }
}

async function parseResponseBody(response) {
  const rawBody = await response.text();

  if (!rawBody) {
    return null;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

async function fetchJsonWithRetry(url, options = {}, config = {}) {
  const {
    retries = 2,
    timeoutMs = 15000,
    retryOnStatuses = [408, 409, 425, 429, 500, 502, 503, 504],
    operation = "HTTP request",
  } = config;

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });

      const data = await parseResponseBody(response);

      if (response.ok) {
        return { response, data };
      }

      const error = new Error(
        `${operation} failed with status ${response.status}`
      );
      error.status = response.status;
      error.data = data;

      if (
        attempt < retries &&
        retryOnStatuses.includes(response.status)
      ) {
        await sleep(250 * (attempt + 1));
        continue;
      }

      throw error;
    } catch (err) {
      lastError = err;

      if (attempt < retries && isRetryableNetworkError(err)) {
        console.warn(`${operation} network error, retrying`, {
          attempt: attempt + 1,
          url,
          message: err.message,
          cause: err.cause?.code || err.code || null,
        });
        await sleep(250 * (attempt + 1));
        continue;
      }

      break;
    }
  }

  console.error(`${operation} failed`, {
    url,
    error: serializeError(lastError),
  });

  throw lastError;
}

async function handleSuccessfulPaymentSession(session) {
  const ghlContactId =
    session.metadata?.ghl_contact_id ||
    session.metadata?.contact_id ||
    session.client_reference_id ||
    null;

  if (!ghlContactId) {
    console.log("No ghlContactId found for payment session:", session.id);
    return;
  }

  const payload = {
    last_stripe_payment_intent_id: session.payment_intent || "",
    last_payment_status: session.payment_status || "paid",
    last_payment_error: "",
    last_payment_amount: formatStripeAmount(session.amount_total, session.currency),
  };

  await updateHighLevelContact(ghlContactId, payload);

  try {
    await upsertHighLevelOpportunity({
      contactId: ghlContactId,
      pipelineId: process.env.GHL_WA_BOT_WEBINAR_PIPELINE_ID,
      pipelineStageId: process.env.GHL_WA_BOT_WEBINAR_PAID_STAGE_ID,
      status: "won",
    });
  } catch (oppErr) {
    console.error("Opportunity update failed after payment:", oppErr);
  }
}

async function handleFailedPaymentSession(session, errorMessage = "") {
  const ghlContactId =
    session.metadata?.ghl_contact_id ||
    session.metadata?.contact_id ||
    session.client_reference_id ||
    null;

  if (!ghlContactId) {
    console.log("No ghlContactId found for failed payment session:", session.id);
    return;
  }

  const payload = {
    last_stripe_payment_intent_id: session.payment_intent || "",
    last_payment_status: session.payment_status || "failed",
    last_payment_error: errorMessage || "Payment failed",
    last_payment_amount: formatStripeAmount(session.amount_total, session.currency),
  };

  await updateHighLevelContact(ghlContactId, payload);

  try {
    await upsertHighLevelOpportunity({
      contactId: ghlContactId,
      pipelineId: process.env.GHL_WA_BOT_WEBINAR_PIPELINE_ID,
      pipelineStageId: process.env.GHL_WA_BOT_WEBINAR_PAYMENT_FAILED_STAGE_ID,
      status: "open",
    });
  } catch (oppErr) {
    console.error("Opportunity update failed after payment failure:", oppErr);
  }
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
    console.log('webhook triggered');

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log("webhook event constructed", {
        id: event.id,
        type: event.type,
      });
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    let dedupeKey;
    let dedupeEnabled = true;

    try {
      dedupeKey = `stripe:event:${event.id}`;
      console.log("webhook dedupe lookup start", { dedupeKey });
      const existingStatus = await safeRedisGet(dedupeKey);
      console.log("webhook dedupe lookup done", { dedupeKey, existingStatus });

      if (existingStatus === "done") {
        console.log("Duplicate webhook ignored:", event.id);
        return res.json({ received: true, duplicate: true });
      }

      console.log("webhook dedupe lock start", { dedupeKey });
      const lockSet = await safeRedisSet(dedupeKey, "processing", {
        nx: true,
        ex: 60 * 10,
      });
      console.log("webhook dedupe lock done", { dedupeKey, lockSet });

      if (lockSet === null) {
        dedupeEnabled = false;
        console.warn("Redis unavailable, continuing webhook without dedupe", {
          eventId: event.id,
          dedupeKey,
        });
      }
      
      if (dedupeEnabled && !lockSet && existingStatus === "processing") {
        console.log("Webhook already processing:", event.id);
        return res.json({ received: true, processing: true });
      }

      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          console.log("processing checkout.session.completed", {
            sessionId: session.id,
            mode: session.mode,
            ghlContactId: session.metadata?.ghl_contact_id || null,
            setupIntentId: session.setup_intent || null,
          });
      
          if (session.mode === "setup") {
            const setupIntentId = session.setup_intent;
            const ghlContactId = session.metadata?.ghl_contact_id || null;
      
            if (!setupIntentId) {
              console.log("No setup_intent found on session");
              break;
            }
      
            const setupIntent = await stripe.setupIntents.retrieve(setupIntentId, {
              expand: ["payment_method"],
            });
            console.log("setup intent retrieved", {
              setupIntentId: setupIntent.id,
              customerId: setupIntent.customer || null,
              paymentMethodId:
                typeof setupIntent.payment_method === "string"
                  ? setupIntent.payment_method
                  : setupIntent.payment_method?.id || null,
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
      
            if (ghlContactId) {
              console.log("ghl contact update start", { ghlContactId });
              await updateHighLevelContact(ghlContactId, payload);
              console.log("ghl contact update done", { ghlContactId });
      
              try {
                console.log("ghl opportunity upsert start", { ghlContactId });
                await upsertHighLevelOpportunity({
                  contactId: ghlContactId,
                  pipelineId: process.env.GHL_WA_BOT_WEBINAR_PIPELINE_ID,
                  pipelineStageId:
                    process.env.GHL_WA_BOT_WEBINAR_CARD_ON_FILE_STAGE_ID,
                });
                console.log("ghl opportunity upsert done", { ghlContactId });
              } catch (oppErr) {
                console.error("Opportunity update failed:", serializeError(oppErr));
              }
            } else {
              console.log("No ghlContactId found");
            }
      
            break;
          }
      
          if (session.mode === "payment") {
            await handleSuccessfulPaymentSession(session);
            break;
          }
      
          console.log("Unhandled checkout.session.completed mode:", session.mode);
          break;
        }
      
        case "checkout.session.async_payment_succeeded": {
          const session = event.data.object;
          await handleSuccessfulPaymentSession(session);
          break;
        }
      
        case "checkout.session.async_payment_failed": {
          const session = event.data.object;
          await handleFailedPaymentSession(session, "Async payment failed");
          break;
        }

	case "payment_intent.payment_failed": {
          const pi = event.data.object;
        
          const ghlContactId =
            pi.metadata?.ghl_contact_id ||
            pi.metadata?.contact_id ||
            null;
        
          if (!ghlContactId) {
            console.log("No ghlContactId found for failed PaymentIntent:", pi.id);
            break;
          }
        
          await updateHighLevelContact(ghlContactId, {
            last_stripe_payment_intent_id: pi.id || "",
            last_payment_status: pi.status || "failed",
            last_payment_error: pi.last_payment_error?.message || "Payment failed",
            last_payment_amount: pi.amount ?? "",
          });
        
          try {
            await upsertHighLevelOpportunity({
              contactId: ghlContactId,
              pipelineId: process.env.GHL_WA_BOT_WEBINAR_PIPELINE_ID,
              pipelineStageId: process.env.GHL_WA_BOT_WEBINAR_PAYMENT_FAILED_STAGE_ID,
              status: "open",
            });
          } catch (oppErr) {
            console.error("Opportunity update failed after PI failure:", oppErr);
          }
        
          break;
        }
      
        default:
          console.log(`Unhandled event type: ${event.type}`);
      }

      if (dedupeEnabled) {
        console.log("webhook dedupe complete mark start", { dedupeKey });
        await safeRedisSet(dedupeKey, "done", {
          ex: 60 * 60 * 24 * 7,
        });
        console.log("webhook dedupe complete mark done", { dedupeKey });
      }

      res.json({ received: true });
    } catch (err) {
      if (dedupeKey && dedupeEnabled) {
        console.log("webhook dedupe cleanup start", { dedupeKey });
        await safeRedisDel(dedupeKey);
        console.log("webhook dedupe cleanup done", { dedupeKey });
      }
      console.error("Webhook handler failed:", serializeError(err));
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

  const { data } = await fetchJsonWithRetry(
    `${GHL_API_BASE_URL}/contacts/${ghlContactId}`,
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
    },
    {
      operation: `GHL contact update for ${ghlContactId}`,
    }
  );

  return data;
}

app.post("/start-card-setup", async (req, res) => {
  try {
    const { name, last_name, email, whatsapp, country_code, consent, consent_text_version, entry_point } = req.body;

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
    const opportunityConfig = getEntryPointOpportunityConfig(entry_point);

    try {
      await upsertHighLevelOpportunity({
        contactId: ghlContactId,
        pipelineStageId: opportunityConfig.pipelineStageId,
        source: opportunityConfig.source,
        opportunityName: `${name || ""} ${last_name || ""}`.trim() || "New Lead",
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

    // Construir success_url con todos los datos del contacto
    const successUrl = new URL(process.env.SUCCESS_URL);
    successUrl.searchParams.set('contact_id', ghlContactId);
    successUrl.searchParams.set('first_name', name || '');
    successUrl.searchParams.set('last_name', last_name || '');
    successUrl.searchParams.set('email', email || '');
    successUrl.searchParams.set('phone', normalizedPhone || '');

    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      customer: customerId,
      currency: "mxn",
      locale: "es-419",
      success_url: successUrl.toString(),
      cancel_url: process.env.CANCEL_URL,
      metadata: {
        ghl_contact_id: ghlContactId,
        source: "gohighlevel",
        entry_point: entry_point || "start_card_setup",
        purpose: "save_card_for_future_charge",
        consent: "true",
        consent_text_version: consent_text_version || "v1",
	consent_timestamp: consentTimestamp
      },
      setup_intent_data: {
        metadata: {
          ghl_contact_id: ghlContactId,
          source: "gohighlevel",
          entry_point: entry_point || "start_card_setup",
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

async function startCardSetupRecovery(req, res, contactId) {
  try {
    const {
      success_url,
      cancel_url,
      locale,
      consent_text_version,
    } = req.query;

    if (!contactId) {
      return res.status(400).send("Missing contact_id");
    }

    const finalSuccessUrl = success_url || process.env.SUCCESS_URL;
    const finalCancelUrl = cancel_url || process.env.CANCEL_URL;

    if (!finalSuccessUrl || !finalCancelUrl) {
      return res.status(400).send("Missing success_url or cancel_url");
    }

    // 1) Fetch contact from GHL
    const ghlContact = await getHighLevelContact(contactId);

    if (!ghlContact?.id) {
      return res.status(404).send("GHL contact not found");
    }

    const firstName = ghlContact.firstName || "";
    const lastName = ghlContact.lastName || "";
    const email = ghlContact.email || "";
    const phone = normalizePhone(ghlContact.phone || "");

    // 2) Get existing Stripe data from GHL custom fields
    const contactPaymentData = await getHighLevelContactPaymentData(ghlContact.id);
    let customerId = contactPaymentData.stripe_customer_id || null;

    // 3) Create Stripe customer only if missing
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: email || undefined,
        name: `${firstName} ${lastName}`.trim() || undefined,
        phone: phone || undefined,
        metadata: {
          ghl_contact_id: ghlContact.id,
          source: "gohighlevel_recovery",
        },
      });

      customerId = customer.id;
    }

    // 4) Create setup checkout session
    const consentTimestamp = new Date().toISOString();
    const successUrl = new URL(finalSuccessUrl);
    successUrl.searchParams.set('contact_id', ghlContact.id);
    successUrl.searchParams.set('first_name', firstName || '');
    successUrl.searchParams.set('last_name', lastName || '');
    successUrl.searchParams.set('email', email || '');
    successUrl.searchParams.set('phone', phone || '');

    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      customer: customerId,
      currency: "mxn",
      locale: locale || "es-419",
      success_url: successUrl.toString(),
      cancel_url: finalCancelUrl,
      metadata: {
        ghl_contact_id: ghlContact.id,
        source: "gohighlevel_recovery",
        purpose: "save_card_for_future_charge",
        consent: "true",
        consent_text_version: consent_text_version || "recovery_v1",
        consent_timestamp: consentTimestamp,
      },
      setup_intent_data: {
        metadata: {
          ghl_contact_id: ghlContact.id,
          source: "gohighlevel_recovery",
        },
      },
    });

    // 5) Update GHL contact immediately
    await updateHighLevelContact(ghlContact.id, {
      stripe_customer_id: customerId,
      stripe_setup_status: "pending",
      consent_given: "true",
      consent_timestamp: consentTimestamp,
      consent_version: consent_text_version || "recovery_v1",
    });

    // 6) Optional: move opportunity back into the right stage
    try {
      await upsertHighLevelOpportunity({
        contactId: ghlContact.id,
        pipelineId: process.env.GHL_WA_BOT_WEBINAR_PIPELINE_ID,
        pipelineStageId: process.env.GHL_WA_BOT_WEBINAR_RECOVERY_STAGE_ID,
        opportunityName:
          `${firstName || ""} ${lastName || ""}`.trim() || "Recovery Lead",
      });
    } catch (oppErr) {
      console.error("Opportunity update failed in recovery flow:", oppErr);
    }

    // 7) Redirect to Stripe
    return res.redirect(303, session.url);
  } catch (err) {
    console.error("Error in /start-card-setup-recovery:", err);
    return res.status(500).send(err.message || "Failed to start recovery card setup flow");
  }
}

app.get("/start-card-setup-recovery", async (req, res) => {
  return startCardSetupRecovery(req, res, req.query.contact_id);
});

app.get("/start-card-setup-recovery/:contact_id", async (req, res) => {
  return startCardSetupRecovery(req, res, req.params.contact_id);
});

app.post("/upsert-and-redirect", async (req, res) => {
  try {
    const {
      name,
      last_name,
      email,
      whatsapp,
      country_code,
      destination_url,
      consent,
      consent_text_version,
      entry_point,
      extra_params = {},
    } = req.body;

    if (!destination_url) {
      return res.status(400).json({ error: "destination_url is required" });
    }

    if (!name || !email) {
      return res.status(400).json({
        error: "name and email are required",
      });
    }

    // Validación básica del destino — solo permitimos dominios propios
    const allowedHosts = (process.env.ALLOWED_REDIRECT_HOSTS || "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);

    let destUrl;
    try {
      destUrl = new URL(destination_url);
    } catch {
      return res.status(400).json({ error: "destination_url is not a valid URL" });
    }

    if (allowedHosts.length && !allowedHosts.includes(destUrl.hostname.toLowerCase())) {
      return res.status(400).json({
        error: `destination_url host not allowed: ${destUrl.hostname}`,
      });
    }

    const fullPhone = `${country_code || ""}${whatsapp || ""}`;
    const normalizedPhone = normalizePhone(fullPhone);

    // 1) Upsert en GHL
    const contact = await upsertHighLevelContact({
      firstName: name,
      lastName: last_name || "",
      email,
      phone: normalizedPhone,
    });

    const ghlContactId = contact.id;
    if (!ghlContactId) {
      throw new Error("GHL upsert did not return a contact ID");
    }

    // 2) Opportunity en pipeline (igual que en /start-card-setup)
    const opportunityConfig = getEntryPointOpportunityConfig(entry_point);

    try {
      await upsertHighLevelOpportunity({
        contactId: ghlContactId,
        pipelineStageId: opportunityConfig.pipelineStageId,
        source: opportunityConfig.source,
        opportunityName:
          `${name || ""} ${last_name || ""}`.trim() || "New Lead",
      });
    } catch (oppErr) {
      console.error("Opportunity creation failed in upsert-and-redirect:", oppErr);
    }

    // 3) Guardar consent si vino
    if (consent) {
      try {
        await updateHighLevelContact(ghlContactId, {
          consent_given: "true",
          consent_timestamp: new Date().toISOString(),
          consent_version: consent_text_version || "v1",
        });
      } catch (consentErr) {
        console.error("Consent update failed:", consentErr);
      }
    }

    // 4) Construir URL final con contact_id + datos GHL-standard + extras
    destUrl.searchParams.set("contact_id", ghlContactId);
    destUrl.searchParams.set("first_name", name || "");
    destUrl.searchParams.set("last_name", last_name || "");
    destUrl.searchParams.set("email", email || "");
    destUrl.searchParams.set("phone", normalizedPhone || "");

    // Params adicionales (UTMs, IDs internos, etc.)
    for (const [key, value] of Object.entries(extra_params)) {
      if (value !== undefined && value !== null && value !== "") {
        destUrl.searchParams.set(key, String(value));
      }
    }

    // 5) Redirect
    return res.redirect(303, destUrl.toString());
  } catch (err) {
    console.error("Error in /upsert-and-redirect:", err);
    return res.status(500).json({
      error: err.message || "Failed to upsert and redirect",
    });
  }
});

app.get("/ghl/custom-fields", async (req, res) => {
  try {
    const { data } = await fetchJsonWithRetry(
      `${GHL_API_BASE_URL}/locations/${process.env.GHL_LOCATION_ID}/customFields`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.GHL_API_KEY}`,
          Version: "2021-07-28",
          Accept: "application/json",
        },
      },
      {
        operation: "GHL custom fields fetch",
      }
    );
    res.json(data);
  } catch (err) {
    console.error("Error fetching custom fields:", err);
    res.status(500).json({ error: err.message });
  }
});

async function getHighLevelContact(ghlContactId) {
  const { data } = await fetchJsonWithRetry(
    `${GHL_API_BASE_URL}/contacts/${ghlContactId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        Version: "2021-07-28",
        Accept: "application/json",
      },
    },
    {
      operation: `GHL contact fetch for ${ghlContactId}`,
    }
  );

  return data.contact || data;
}

async function getHighLevelContactPaymentData(ghlContactId) {
  const { data } = await fetchJsonWithRetry(
    `${GHL_API_BASE_URL}/contacts/${ghlContactId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        Version: "2021-07-28",
        Accept: "application/json",
      },
    },
    {
      operation: `GHL payment data fetch for ${ghlContactId}`,
    }
  );

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
  const { data } = await fetchJsonWithRetry(
    `${GHL_API_BASE_URL}/contacts/upsert`,
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
    },
    {
      operation: "GHL contact upsert",
    }
  );

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
      opportunity_id, // optional if you have it
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
      price_id: String(price_id),
    };

    if (contact_id) {
      metadata.ghl_contact_id = String(contact_id);
    }

    if (opportunity_id) {
      metadata.ghl_opportunity_id = String(opportunity_id);
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
      payment_intent_data: {
        metadata,
      },
    };

    if (customer_id) {
      sessionParams.customer = String(customer_id);
    } else {
      sessionParams.customer_creation = "always";

      if (email) {
        sessionParams.customer_email = String(email);
      }
    }

    if (contact_id) {
      sessionParams.client_reference_id = String(contact_id);
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
  opportunityName,
  pipelineId = process.env.GHL_WA_BOT_WEBINAR_PIPELINE_ID,
  pipelineStageId = process.env.GHL_WA_BOT_WEBINAR_NEW_LEAD_STAGE_ID,
  status = "open",
  source = "custom_form"
}) {
  const body = {
    locationId: process.env.GHL_LOCATION_ID,
    contactId,
    pipelineId,
    pipelineStageId,
    status,
    source,
  };

  // only add name if provided
  if (opportunityName && opportunityName.trim()) {
    body.name = opportunityName.trim();
  }

  const { data } = await fetchJsonWithRetry(
    `${GHL_API_BASE_URL}/opportunities/upsert`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    },
    {
      operation: `GHL opportunity upsert for ${contactId}`,
    }
  );

  return data.opportunity || data;
}

module.exports = app;
