import { authenticate } from "../shopify.server";
import { useLanguage } from "../context/LanguageContext";

//placeholder page -- product volume (quantity break) discounts aren't built yet
//loader
export const loader = async ({ request }) => {
    await authenticate.admin(request);
    return {};
};
//UI
export default function ProductVolumePlaceholder() {
    const { t: { discounts: t } } = useLanguage();

    return (
        <s-page heading={t.type_productVolume_title}>
            <s-link href="/app/discounts" slot="breadcrumb-actions">{t.heading}</s-link>
            <s-section>
                <s-stack direction="block" gap="small-200" alignItems="center">
                    <s-icon type="discount-add" />
                    <s-text type="strong">{t.comingSoonHeading}</s-text>
                    <s-text color="subdued">{t.comingSoonMessage}</s-text>
                    <s-button href="/app/discounts">{t.heading}</s-button>
                </s-stack>
            </s-section>
        </s-page>
    );
}
