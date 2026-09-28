(function () {
  "use strict";

  // Flip back to true only if you need to re-diagnose cart sync behavior.
  // this wil appear in the console logs to check 
  var DEBUG = false;
  function log() {
    if (DEBUG && window.console) console.log.apply(console, ["[GWP]"].concat(Array.prototype.slice.call(arguments)));
  }

  var CONFIG_URL = "/apps/gwp/config";
  var PROPERTY_KEY = "_gwp_rule_id";
  var SOURCE = "gwp-auto-gift";
  var MAX_PASSES = 5;

  var rulesPromise = null;
  var syncing = false;

  function getRules() {
    if (!rulesPromise) {
      rulesPromise = fetch(CONFIG_URL, { credentials: "same-origin" })
        .then(function (res) {
          return res.ok ? res.json() : [];
        })
        .catch(function () {
          return [];
        });
    }
    return rulesPromise;
  }

  function getLatestCart() {
    return fetch("/cart.js", { credentials: "same-origin" }).then(function (res) {
      return res.json();
    });
  }

  function qualifyingTotal(cart, rule) {
    var lines = cart.items.filter(function (item) {
      if (rule.appliesToType === "ALL") return true;
      return rule.buyProductIds.indexOf("gid://shopify/Product/" + item.product_id) !== -1;
    });
    if (rule.conditionType === "AMOUNT") {
      return lines.reduce(function (sum, item) {
        return sum + item.line_price / 100;
      }, 0);
    }
    return lines.reduce(function (sum, item) {
      return sum + item.quantity;
    }, 0);
  }

  function tierMet(rule, tier, total) {
    if (rule.conditionType === "AMOUNT") {
      return tier.requiredAmount != null && total >= Number(tier.requiredAmount);
    }
    return tier.requiredQuantity != null && total >= Number(tier.requiredQuantity);
  }

  // Every satisfied tier wants exactly one auto-added line, tagged with a rule+tier id so we
  // can find/adjust/remove *only* the lines we added, without touching anything the customer
  // added themselves.
  function desiredGiftLines(rules, cart) {
    var desired = {};
    rules.forEach(function (rule) {
      var total = qualifyingTotal(cart, rule);
      log("Qualifying quantity:", total, "for rule", rule.discountId);
      (rule.tiers || []).forEach(function (tier, tierIndex) {
        var required = rule.conditionType === "AMOUNT" ? tier.requiredAmount : tier.requiredQuantity;
        var qualified = tierMet(rule, tier, total);
        log("Required quantity:", required, "Qualified:", qualified);
        if (!tier.giftVariantId || !qualified) return;
        var key = rule.discountId + ":" + tierIndex;
        desired[key] = {
          variantId: tier.giftVariantId.split("/").pop(),
          quantity: Number(tier.giftQuantity) || 0,
        };
      });
    });
    return desired;
  }

  function actualGiftLines(cart) {
    var actual = {};
    cart.items.forEach(function (item) {
      var ruleId = item.properties && item.properties[PROPERTY_KEY];
      if (ruleId) actual[ruleId] = item;
    });
    return actual;
  }

  function addGift(variantId, quantity, key) {
    var properties = {};
    properties[PROPERTY_KEY] = key;
    log("Action: add gift", variantId, "x", quantity);
    return fetch("/cart/add.js", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ id: variantId, quantity: quantity, properties: properties }] }),
    });
  }

  function changeGiftQuantity(lineKey, quantity) {
    log("Action:", quantity === 0 ? "remove gift" : "adjust gift quantity to " + quantity);
    return fetch("/cart/change.js", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: lineKey, quantity: quantity }),
    });
  }

  // The single function responsible for syncing GWP state: reads the latest cart, computes the
  // desired gift lines, and adds/adjusts/removes only what's actually out of sync (never blindly
  // re-adds a gift that's already correct) so repeated calls are idempotent and cheap.
  function syncGiftWithPurchaseOnce(rules) {
    return getLatestCart().then(function (cart) {
      log("Latest cart received:", cart.items.length, "line(s)");
      var desired = desiredGiftLines(rules, cart);
      var actual = actualGiftLines(cart);
      var mutations = [];

      Object.keys(desired).forEach(function (key) {
        var want = desired[key];
        var have = actual[key];
        log("Gift variant:", want.variantId, "Current gift quantity:", have ? have.quantity : 0, "Desired gift quantity:", want.quantity);
        if (!have) {
          mutations.push(addGift(want.variantId, want.quantity, key));
        } else if (have.quantity !== want.quantity) {
          mutations.push(changeGiftQuantity(have.key, want.quantity));
        }
      });
      Object.keys(actual).forEach(function (key) {
        if (!desired[key]) mutations.push(changeGiftQuantity(actual[key].key, 0));
      });

      if (mutations.length === 0) {
        log("Action: none (already in sync)");
        return false;
      }
      return Promise.all(mutations).then(function () {
        log("Gift added/removed — refreshing cart UI");
        return notifyThemeOfCartChange();
      }).then(function () {
        return true;
      });
    });
  }

  function syncGiftWithPurchase() {
    if (syncing) return;
    syncing = true;
    getRules()
      .then(function (rules) {
        if (!rules || rules.length === 0) return Promise.resolve();
        var pass = 0;
        function next() {
          pass += 1;
          if (pass > MAX_PASSES) return Promise.resolve();
          return syncGiftWithPurchaseOnce(rules).then(function (changed) {
            return changed ? next() : Promise.resolve();
          });
        }
        return next();
      })
      .catch(function (error) {
        log("Sync failed (ignored, cart left untouched):", error);
      })
      .then(function () {
        syncing = false;
      });
  }

  // This theme (Dawn-based) re-renders its cart drawer/page via a global pubsub
  // (subscribe/publish, from assets/pubsub.js) rather than a DOM CustomEvent — every CartItems
  // instance calls onCartUpdate() whenever anyone publishes PUB_SUB_EVENTS.cartUpdate with a
  // different `source`. We publish it for any other listeners (cart-notification, icon bubble,
  // etc.), but we *also* apply the same section HTML ourselves directly rather than only relying
  // on the theme's own subscriber: its own re-render fetch is dispatched independently of ours,
  // and since network responses aren't guaranteed to resolve in dispatch order, leaving it solely
  // responsible risks a slightly-stale response landing after ours and silently overwriting the
  // correct state. Doing it ourselves, synchronously after our mutation, removes that race.
  var CART_SECTION_TARGETS = [
    { sectionId: "main-cart-items", elementSelector: "cart-items" },
    { sectionId: "cart-drawer", elementSelector: "#CartDrawer" },
    { sectionId: "cart-icon-bubble", elementSelector: "#cart-icon-bubble" },
  ];

  function refreshCartSection(target) {
    return fetch(window.location.pathname + "?section_id=" + target.sectionId, { credentials: "same-origin" })
      .then(function (res) {
        return res.ok ? res.text() : null;
      })
      .then(function (html) {
        if (!html) return;
        var freshEl = new DOMParser().parseFromString(html, "text/html").querySelector(target.elementSelector);
        var liveEl = document.querySelector(target.elementSelector);
        if (freshEl && liveEl) liveEl.innerHTML = freshEl.innerHTML;
      })
      .catch(function () {
        /* this section/selector doesn't exist on this theme/page — fine, others may still apply */
      });
  }

  function notifyThemeOfCartChange() {
    // PUB_SUB_EVENTS is declared with `const` in the theme's constants.js — const/let bindings
    // never attach to `window` (unlike function declarations, which do), so this must be checked
    // as a bare identifier, not window.PUB_SUB_EVENTS (which is always undefined regardless).
    if (typeof window.publish === "function" && typeof PUB_SUB_EVENTS !== "undefined") {
      window.publish(PUB_SUB_EVENTS.cartUpdate, { source: SOURCE });
    }
    return Promise.all(CART_SECTION_TARGETS.map(refreshCartSection)).then(function () {
      log("CART UI refreshed");
    });
  }

  var hasThemePubsub = typeof window.subscribe === "function" && typeof PUB_SUB_EVENTS !== "undefined";

  if (hasThemePubsub) {
    window.subscribe(PUB_SUB_EVENTS.cartUpdate, function (event) {
      if (event && event.source === SOURCE) return; // ignore our own notifications
      log("[CART] Quantity changed (theme cart-update event)");
      syncGiftWithPurchase();
    });
  }

  var CART_MUTATION_RE = /\/cart\/(add|change|update|clear)(\.js)?(?:[/?#]|$)/;

  // Fallback hooks for themes without the pubsub above. Deliberately *not* also wired up when
  // hasThemePubsub is true: the theme's own mutation and our reaction to it both end up
  // refetching/re-rendering the same cart sections, and since network responses aren't
  // guaranteed to resolve in dispatch order, having two independent triggers race for the same
  // real-world event risks the theme's own (now-stale) re-render landing *after* ours and
  // silently overwriting our correction. One trigger source per event avoids that entirely.
  var originalFetch = window.fetch;
  window.fetch = function (input) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var isCartMutation = CART_MUTATION_RE.test(url);
    var result = originalFetch.apply(this, arguments);
    if (isCartMutation && !hasThemePubsub) {
      result.then(function () {
        log("[CART] Quantity changed (fetch)");
        syncGiftWithPurchase();
      });
    }
    return result;
  };

  var OriginalXHR = window.XMLHttpRequest;
  function WrappedXHR() {
    var xhr = new OriginalXHR();
    var isCartMutation = false;
    var originalOpen = xhr.open;
    xhr.open = function (method, url) {
      isCartMutation = CART_MUTATION_RE.test(String(url));
      return originalOpen.apply(xhr, arguments);
    };
    xhr.addEventListener("loadend", function () {
      if (isCartMutation && !hasThemePubsub) {
        log("[CART] Quantity changed (XHR)");
        syncGiftWithPurchase();
      }
    });
    return xhr;
  }
  window.XMLHttpRequest = WrappedXHR;

  document.addEventListener("cart:updated", syncGiftWithPurchase);
  document.addEventListener("DOMContentLoaded", syncGiftWithPurchase);
  if (document.readyState !== "loading") syncGiftWithPurchase();

  // Guaranteed last-resort fallback: some themes submit cart changes in a way no page-level JS
  // hook can observe at all (e.g. a hidden iframe with its own isolated fetch/XHR/pubsub). Poll
  // so the gift still reconciles within a couple seconds no matter how the theme adds to cart.
  setInterval(syncGiftWithPurchase, 2000);
})();
