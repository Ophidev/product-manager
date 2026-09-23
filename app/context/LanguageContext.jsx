//inport three react features createcontext-allows to create shared language storage that can be accessed by different components, usecontext read the language information, usestate store the cuyrrent selected state
//createContext → Create shared language system
// useState      → Store selected language
// useContext    → Access language from any component
import { createContext, useContext, useState } from "react";
import { LANGUAGES, TRANSLATIONS } from "./languageData";

//every page can access the language
const LanguageContext = createContext(null);

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

export function useLanguage() {
    const context = useContext(LanguageContext);
    //Safety check
    if (!context) {
        throw new Error("useLanguage must be used within a LanguageProvider");
    }
    return context;
}
