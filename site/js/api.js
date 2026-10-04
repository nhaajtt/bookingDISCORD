// Every call goes to the same origin: the host rewrites /api/* to the bot, so the login cookie is first-party.

export class ApiFail extends Error {
  constructor(status, error = {}) {
    super(error.message || "Có lỗi xảy ra, bạn thử lại nhé.");
    this.status = status;
    this.code = error.code || "ERROR";
    this.data = error;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`/api/${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiFail(0, { code: "OFFLINE", message: "Không kết nối được. Kiểm tra mạng rồi thử lại nhé." });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* an empty or non-JSON answer is handled below */
  }
  if (!res.ok) throw new ApiFail(res.status, data?.error ?? { code: "ERROR", message: "Máy chủ đang bận, bạn thử lại sau ít phút nhé." });
  return data;
}

let configPromise = null;
// The public settings and who is logged in; asked once per page
export const loadConfig = () => (configPromise ??= api("config"));

let meCache = null;
export async function loadMe(fresh = false) {
  if (meCache && !fresh) return meCache;
  meCache = await api("me");
  return meCache;
}
export const forgetMe = () => {
  meCache = null;
};
