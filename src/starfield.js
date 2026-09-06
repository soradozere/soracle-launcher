// Scoped-down port of Soracle's background-particles.tsx default sky (stars
// only - that component runs to 1400 lines once you count nebulas, galaxies,
// meteors and per-theme variants, none of which this small window needs).
// Same density formula and twinkle curve, kept in sync by hand if that
// component's star generation ever changes.

const canvas = document.getElementById("starfield-canvas");
const ctx = canvas.getContext("2d");

let stars = [];

function themePrimaryRgb() {
  const hex = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || "#66fcf1";
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  initStars();
}

function initStars() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const count = Math.floor((w * h) / 4000);
  stars = Array.from({ length: count }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    size: Math.random() * 1.5 + 0.5,
    opacity: Math.random() * 0.8 + 0.2,
    twinkleSpeed: Math.random() * 0.02 + 0.005,
    twinklePhase: Math.random() * Math.PI * 2,
  }));
}

function animate(time) {
  requestAnimationFrame(animate);
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);

  const color = themePrimaryRgb();
  const t = time * 0.001;
  for (const star of stars) {
    const twinkle = Math.sin(t * star.twinkleSpeed * 60 + star.twinklePhase) * 0.3 + 0.7;
    const opacity = star.opacity * twinkle;
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
    if (star.size > 1.2) {
      ctx.shadowBlur = star.size * 4;
      ctx.shadowColor = `rgba(${color}, ${opacity * 0.5})`;
      ctx.fillStyle = `rgba(${color}, ${opacity})`;
    } else {
      ctx.shadowBlur = 0;
      ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
    }
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

window.addEventListener("resize", resize);
resize();
requestAnimationFrame(animate);
