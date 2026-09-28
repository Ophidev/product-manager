//Import translation files from the locales .json
import en from "../locales/en.json";
import de from "../locales/de.json";
import fr from "../locales/fr.json";
import es from "../locales/es.json";

//code: internal identifier, label : shown to the UI
export const LANGUAGES = [
    { code: "en", label: "English" },
    { code: "de", label: "Deutsch" },
    { code: "fr", label: "Français" },
    { code: "es", label: "Español" },
];

//codes for the translation
export const TRANSLATIONS = { en, de, fr, es };

// Fills "{key}" placeholders in a template string with values from vars.
export function format(template, vars) {
    return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}
