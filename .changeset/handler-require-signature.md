---
'@adonis-agora/media': patch
---

`MediaDeliveryHandler` takes `requireSignature`, which overrides `delivery.signing.required` for its route. Before, turning on signing (required by default) made every delivery route refuse unsigned requests, including those that already authorize by session or ownership. A route like that can now opt out with `requireSignature: false`: it keeps serving its own requests and still honours signed ones. `media.library.checkDeliverySignature(request, { required })` takes the same override.
