# GHL + Stripe Card on File

Este proyecto conecta formularios de landing pages con GoHighLevel (GHL) y Stripe.

## Entry points principales

Hay dos landings principales:

| Landing | Endpoint | Objetivo | `entry_point` |
| --- | --- | --- | --- |
| Pay Later | `POST /start-card-setup` | Crear/upsert contacto en GHL, crear opportunity, mandar a Stripe Setup Checkout para guardar tarjeta | `pay_later` |
| Pay Now | `POST /upsert-and-redirect` | Crear/upsert contacto en GHL, crear opportunity, redirigir al checkout/pagina de pago | `pay_now` |

El form no debe mandar IDs internos de GHL como `pipelineStageId`. Solo debe mandar un valor semantico en `entry_point`. El backend decide a que stage enviar el lead.

## Pipeline stages por entry point

La funcion `getEntryPointOpportunityConfig(entryPoint)` traduce el entry point a un stage permitido:

| `entry_point` | Env var usada para stage | `source` enviado a GHL |
| --- | --- | --- |
| `pay_later` | `GHL_WA_BOT_WEBINAR_PAY_LATER_ENTRY_STAGE_ID` | `landing_pay_later` |
| `pay_now` | `GHL_WA_BOT_WEBINAR_PAY_NOW_ENTRY_STAGE_ID` | `landing_pay_now` |
| vacio/desconocido | `GHL_WA_BOT_WEBINAR_NEW_LEAD_STAGE_ID` | `custom_form` |

Si una env var especifica no existe, el backend cae al stage default:

```txt
GHL_WA_BOT_WEBINAR_NEW_LEAD_STAGE_ID
```

## Env vars necesarias en Vercel

Configurar estas variables con los IDs reales del pipeline/stages de GHL:

```txt
GHL_WA_BOT_WEBINAR_PIPELINE_ID=...
GHL_WA_BOT_WEBINAR_NEW_LEAD_STAGE_ID=...
GHL_WA_BOT_WEBINAR_PAY_LATER_ENTRY_STAGE_ID=...
GHL_WA_BOT_WEBINAR_PAY_NOW_ENTRY_STAGE_ID=...
GHL_WA_BOT_WEBINAR_CARD_ON_FILE_STAGE_ID=...
GHL_WA_BOT_WEBINAR_PAID_STAGE_ID=...
GHL_WA_BOT_WEBINAR_PAYMENT_FAILED_STAGE_ID=...
GHL_WA_BOT_WEBINAR_RECOVERY_STAGE_ID=...
```

Tambien se usan estas para redirecciones y seguridad:

```txt
SUCCESS_URL=...
CANCEL_URL=...
PAYMENT_SUCCESS_URL=...
PAYMENT_CANCEL_URL=...
ALLOWED_REDIRECT_HOSTS=dominio1.com,dominio2.com
```

## Pay Later flow

Endpoint:

```txt
POST https://ghl-stripe-card-on-file.vercel.app/start-card-setup
```

Payload esperado:

```json
{
  "name": "Nombre",
  "last_name": "Apellido",
  "email": "lead@example.com",
  "whatsapp": "6641234567",
  "country_code": "+52",
  "consent": true,
  "consent_text_version": "v1",
  "entry_point": "pay_later"
}
```

Que hace:

1. Valida consentimiento y datos requeridos.
2. Crea o actualiza el contacto en GHL.
3. Crea o actualiza la opportunity en el stage de Pay Later.
4. Busca o crea Stripe Customer.
5. Crea Stripe Checkout Session en modo `setup` para guardar tarjeta.
6. Guarda `stripe_setup_status=pending` en GHL.
7. Redirige al usuario a Stripe.

Cuando Stripe confirma que la tarjeta quedo guardada, el webhook mueve la opportunity al stage:

```txt
GHL_WA_BOT_WEBINAR_CARD_ON_FILE_STAGE_ID
```

## Pay Now flow

Endpoint:

```txt
POST https://ghl-stripe-card-on-file.vercel.app/upsert-and-redirect
```

Payload esperado:

```json
{
  "name": "Nombre",
  "last_name": "Apellido",
  "email": "lead@example.com",
  "whatsapp": "6641234567",
  "country_code": "+52",
  "destination_url": "https://tu-dominio.com/checkout-o-pagina-de-pago",
  "consent": true,
  "consent_text_version": "v1",
  "entry_point": "pay_now",
  "extra_params": {
    "utm_source": "landing",
    "utm_campaign": "pay_now"
  }
}
```

Que hace:

1. Valida `destination_url`, `name` y `email`.
2. Verifica que el host de `destination_url` este permitido en `ALLOWED_REDIRECT_HOSTS`.
3. Crea o actualiza el contacto en GHL.
4. Crea o actualiza la opportunity en el stage de Pay Now.
5. Guarda consentimiento si vino en el payload.
6. Agrega `contact_id`, nombre, email y telefono a la URL destino.
7. Agrega `extra_params` a la URL destino.
8. Redirige al usuario.

Si el pago se procesa despues via Stripe Checkout y llega webhook de pago exitoso, el backend mueve la opportunity al stage:

```txt
GHL_WA_BOT_WEBINAR_PAID_STAGE_ID
```

Si falla el pago, la mueve al stage:

```txt
GHL_WA_BOT_WEBINAR_PAYMENT_FAILED_STAGE_ID
```

## Recovery card setup

Se mantienen dos formas equivalentes para iniciar recovery:

```txt
GET /start-card-setup-recovery?contact_id={{contact.id}}
GET /start-card-setup-recovery/{{contact.id}}
```

Ejemplo final:

```txt
https://ghl-stripe-card-on-file.vercel.app/start-card-setup-recovery/{{contact.id}}
```

Que hace:

1. Busca el contacto existente en GHL.
2. Busca o crea Stripe Customer.
3. Crea Stripe Checkout Session en modo `setup`.
4. Actualiza el contacto como `stripe_setup_status=pending`.
5. Mueve la opportunity al recovery stage:

```txt
GHL_WA_BOT_WEBINAR_RECOVERY_STAGE_ID
```

## Reglas importantes

- Las landings deben mandar `entry_point`, no IDs de stages.
- Los stage IDs viven en Vercel como env vars.
- Si falta `entry_point`, el lead entra al stage default `GHL_WA_BOT_WEBINAR_NEW_LEAD_STAGE_ID`.
- Si falta una env var especifica de Pay Now o Pay Later, tambien cae al stage default.
- `ALLOWED_REDIRECT_HOSTS` debe incluir los dominios permitidos para `destination_url`.
- Despues de cambiar env vars en Vercel, redeploy/restart para que el backend tome los nuevos valores.

## Checklist para agregar una nueva landing

1. Elegir un nuevo `entry_point`, por ejemplo `webinar_partner`.
2. Crear el stage en GHL y copiar su ID.
3. Agregar una env var para ese stage en Vercel.
4. Agregar el mapping en `getEntryPointOpportunityConfig`.
5. Mandar ese `entry_point` desde el form.
6. Probar que la opportunity cae en el stage esperado.

