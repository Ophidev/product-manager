//inport three react features createcontext-allows to create shared language storage that can be accessed by different components, usecontext read the language information, usestate store the cuyrrent selected state
//createContext → Create shared language system
// useState      → Store selected language
// useContext    → Access language from any component
import { createContext, useContext, useState } from "react";
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
const TRANSLATIONS = { en, de, fr, es };
//every page can access the language
const LanguageContext = createContext(null);

// Fills "{key}" placeholders in a template string with values from vars.
export function format(template, vars) {
    return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

//Its job is to make language information available to all components inside it.
export function LanguageProvider({ children }) {
    const [language, setLanguage] = useState(LANGUAGES[0].code);//default language is english[0]
    const t = TRANSLATIONS[language] ?? TRANSLATIONS.en;
//sharing the language information with the entire application 
    return (
        <LanguageContext.Provider value={{ language, setLanguage, t }}>
            {children}
        </LanguageContext.Provider>
    );
}

// t

export function useLanguage() {
    const context = useContext(LanguageContext);
    //Safety check
    if (!context) {
        throw new Error("useLanguage must be used within a LanguageProvider");
    }
    return context;
}
