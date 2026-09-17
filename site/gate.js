// Subscribe-form handling. Config comes from window.DS_SUB
// ({endpoint, linkedin}) injected inline at build time. Issue pages show
// full content — no teaser/paywall. Forms (e.g. the index subscribe band)
// route to the ESP endpoint if configured, else to the LinkedIn newsletter.
(function () {
  var CFG = window.DS_SUB || { endpoint: "", linkedin: "#" };

  // Wire every subscribe form (e.g. index band).
  document.querySelectorAll("form.ds-sub").forEach(function (f) {
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = f.querySelector('input[type="email"]');
      var email = ((input && input.value) || "").trim();
      if (!email) return;
      if (CFG.endpoint) {
        var thanks = function () {
          f.outerHTML = '<div class="ds-thanks">✓ You’re on the list — watch your inbox for the next signal.</div>';
        };
        fetch(CFG.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email }),
        }).then(thanks, thanks);
      } else {
        f.outerHTML = '<div class="ds-thanks">This site doesn\'t send emails yet — subscribe on the real LinkedIn newsletter instead.</div><a class="ds-li" href="' + CFG.linkedin + '" target="_blank" rel="noopener">Subscribe on LinkedIn →</a>';
      }
    });
  });
})();
