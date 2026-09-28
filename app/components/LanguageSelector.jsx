import { useLanguage } from "../context/LanguageContext";
import { LANGUAGES } from "../context/languageData";
//inporting the languages from the languageContext 
const MENU_ID = "language-selector-menu"; //this will help to take the command from the UI to present the list of language to choose

// Compact language switcher for the Home page header. Renders a button
// showing the currently selected language and a menu to change it, using
// the same commandFor/s-menu pattern as the row action menus elsewhere
// in the app (e.g. app.collections._index.jsx) so it anchors correctly.
//component for the language selector 
export function LanguageSelector() {
    //this will allow to check the current language and change the language as set language
    const { language, setLanguage } = useLanguage();
    const current = LANGUAGES.find((item) => item.code === language) ?? LANGUAGES[0]; //function allows to match the language===language if not then fallback function languages[0] means english 0=english 1somelanguage 

    return (
        <>
            <s-button
                slot="secondary-actions"
                variant="secondary"
                icon="chevron-down"
                commandFor={MENU_ID}
                accessibilityLabel={`Change language, currently ${current.label}`}
            >
                {current.label}
            </s-button>
            <s-menu id={MENU_ID} accessibilityLabel="Choose language">
                {LANGUAGES.map((item) => (
                    <s-button
                        key={item.code}
                        variant="tertiary"
                        icon={item.code === current.code ? "check" : undefined}
                        onClick={() => setLanguage(item.code)}
                    >
                        {item.label}
                    </s-button>
                ))}
            </s-menu>
        </>
    );
}
