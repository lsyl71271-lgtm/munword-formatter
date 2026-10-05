/** XML 1.0 characters: reject invalid input, never silently strip source text. */
export const validXmlText = (text: string) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]/u.test(text);

export class InvalidRequestError extends Error {}

export function validateReview(model: Record<string, unknown>) {
  for (const key of ["title", "committee", "topic", "country", "delegate", "sponsors", "signatories"]) {
    const value = model[key], list = key === "sponsors" || key === "signatories";
    const values = list ? value : [value];
    if (!Array.isArray(values) || (list && values.length > 300) || values.some(item => typeof item !== "string" || item.length > (list ? 200 : 5000) || !validXmlText(item))) {
      throw new InvalidRequestError(`第 03 步字段 ${key} 过长、类型无效或含有 XML 不支持的字符。`);
    }
  }
  if (!["zh", "en"].includes(model.language as string)) throw new InvalidRequestError("第 03 步语言只能为 zh 或 en。");
}
