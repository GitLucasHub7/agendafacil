// Login, cadastro e recuperação de senha (Firebase Authentication — e-mail e senha).
(function () {
  const $ = (s) => document.querySelector(s);
  const next = AF.safeNext(new URLSearchParams(location.search).get("next"), "painel.html");
  const forms = { signin: $("#form-signin"), signup: $("#form-signup"), reset: $("#form-reset") };
  const message = $("#auth-message");

  function say(text, kind) {
    message.textContent = text;
    message.className = "auth-message " + (kind || "");
    message.hidden = !text;
  }

  function show(name) {
    for (const [key, form] of Object.entries(forms)) form.hidden = key !== name;
    $("#tab-signin").setAttribute("aria-selected", String(name === "signin"));
    $("#tab-signup").setAttribute("aria-selected", String(name === "signup"));
    say("");
  }

  async function run(form, task) {
    const button = form.querySelector("button[type=submit]");
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Aguarde…";
    try {
      await task();
    } catch (err) {
      console.error(err);
      say(AF.mapAuthError(err), "error");
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  if (!AF.ready) {
    say("O Firebase não iniciou: " + (AF.initError || "confira public/firebase-config.js") + ".", "error");
    for (const form of Object.values(forms)) form.querySelectorAll("input,button").forEach((el) => (el.disabled = true));
    return;
  }
  AF.redirectIfSignedIn(next);

  $("#tab-signin").addEventListener("click", () => show("signin"));
  $("#tab-signup").addEventListener("click", () => show("signup"));
  $("#goto-reset").addEventListener("click", () => {
    $("#reset-email").value = $("#signin-email").value.trim();
    show("reset");
  });
  $("#goto-signin").addEventListener("click", () => show("signin"));

  forms.signin.addEventListener("submit", (event) => {
    event.preventDefault();
    const email = $("#signin-email").value.trim();
    const password = $("#signin-password").value;
    if (!email || !password) return say("Informe e-mail e senha.", "error");
    run(forms.signin, async () => {
      await AF.auth.signInWithEmailAndPassword(email, password);
      AF.go(next);
    });
  });

  forms.signup.addEventListener("submit", (event) => {
    event.preventDefault();
    const email = $("#signup-email").value.trim();
    const password = $("#signup-password").value;
    if (!email) return say("Informe o seu e-mail.", "error");
    if (password.length < 8) return say("A senha precisa ter ao menos 8 caracteres.", "error");
    if (password !== $("#signup-password2").value) return say("As senhas não conferem.", "error");
    run(forms.signup, async () => {
      const cred = await AF.auth.createUserWithEmailAndPassword(email, password);
      try {
        await cred.user.sendEmailVerification();
      } catch (err) {
        console.warn("Não foi possível enviar o e-mail de verificação agora:", err); // reenvio disponível no painel
      }
      AF.go(next);
    });
  });

  forms.reset.addEventListener("submit", (event) => {
    event.preventDefault();
    const email = $("#reset-email").value.trim();
    if (!email) return say("Digite o e-mail da sua conta.", "error");
    run(forms.reset, async () => {
      try {
        await AF.auth.sendPasswordResetEmail(email);
      } catch (err) {
        // Não revela se o e-mail existe (evita enumeração de contas).
        if (err && err.code !== "auth/user-not-found") throw err;
      }
      say("Se existir uma conta com esse e-mail, enviamos um link para criar uma nova senha. Confira também o spam.", "success");
    });
  });
})();
