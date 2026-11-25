// A password screen in front of the app. Only a PBKDF2 fingerprint of the password is in this public code
// (300,000 rounds of SHA-256, with a salt), never the password itself. Once it's typed correctly, this device
// remembers it. (The code is public on GitHub, so this keeps people out of the app, but can't hide its code.)
(() => {
  const SALT = "2401bdd0d701fcfa44b687a54c6242e3", ROUNDS = 300000, HASH = "f64e8bf87fe83444fc378bad221bef5508837c897ee031b18f866054eb4944ed";
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;         // (testing on this computer)
  try { if (localStorage.getItem("keyfall:unlock") === HASH) return; } catch (e) {}
  document.documentElement.classList.add("locked");
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  const bytes = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
  async function matches(pw) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: bytes(SALT), iterations: ROUNDS, hash: "SHA-256" }, key, 256);
    return hex(bits) === HASH;
  }
  function show() {
    const g = document.createElement("div"); g.id = "gate";
    g.innerHTML = '<form class="gatecard"><div class="brand">Keyfall</div><p>Enter the password to open the app.</p>' +
      '<input id="gatePw" type="password" autocomplete="current-password" autocapitalize="none" spellcheck="false" placeholder="Password">' +
      '<button class="primary" type="submit">Open</button><p id="gateMsg"></p></form>';
    document.body.append(g);
    const form = g.querySelector("form"), input = g.querySelector("#gatePw"), msg = g.querySelector("#gateMsg");
    input.focus();
    form.onsubmit = async ev => {
      ev.preventDefault();
      const pw = input.value.trim().toLowerCase().replace(/\s+/g, "-");
      msg.textContent = "Checking…";
      let ok = false; try { ok = await matches(pw); } catch (e) {}
      if (!ok) { msg.textContent = "That's not the password."; input.select(); return; }
      try { localStorage.setItem("keyfall:unlock", HASH); } catch (e) {}
      document.documentElement.classList.remove("locked"); g.remove();
    };
  }
  if (document.body) show(); else document.addEventListener("DOMContentLoaded", show);
})();
