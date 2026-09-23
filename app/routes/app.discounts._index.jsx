import { useLoaderData, useFetcher } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import { useLanguage } from "../context/LanguageContext";
import { format } from "../context/languageData";

const DISCOUNT_TYPES = [
    { key: "sale", href: "/app/discounts/new", icon: "discount" },
    { key: "giftWithPurchase", href: "/app/gift-with-purchase/new", icon: "gift-card" },
    { key: "productVolume", href: "/app/product-volume/new", icon: "discount-add" },
    { key: "custom", href: "/app/custom/new", icon: "settings" },
    { key: "shipping", href: "/app/shipping/new", icon: "delivery" },
];
//loader-- to get the data from the admin
export const loader = async ({ request }) => {
    console.log("Loader : fetched the data");
    const { admin } = await authenticate.admin(request);

    const codeResponse = await admin.graphql(`
        #graphql
        query ListDiscountCodes {
            codeDiscountNodes(first: 50) {
                nodes {
                    id
                    codeDiscount {
                        ... on DiscountCodeBasic {
                            title
                            status
                            codes(first: 1) {
                                nodes { code }
                            }
                            customerGets {
                                value {
                                    ... on DiscountPercentage { percentage }
                                }
                                items {
                                    ... on DiscountCollections {
                                        collections(first: 10) {
                                            nodes { title }
                                        }
                                    }
                                }
                            }
                        }
                        ... on DiscountCodeBxgy {
                            title
                            status
                            codes(first: 1) {
                                nodes { code }
                            }
                            customerGets {
                                items {
                                    ... on DiscountProducts {
                                        products(first: 5) { nodes { title } }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    `);
    const automaticResponse = await admin.graphql(`
        #graphql
        query ListAutomaticDiscounts {
            automaticDiscountNodes(first: 50) {
                nodes {
                    id
                    automaticDiscount {
                        ... on DiscountAutomaticBxgy {
                            title
                            status
                            customerGets {
                                items {
                                    ... on DiscountProducts {
                                        products(first: 5) { nodes { title } }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    `);

    const codeData = (await codeResponse.json()).data;
    const automaticData = (await automaticResponse.json()).data;

    const codeDiscounts = codeData.codeDiscountNodes.nodes
        .filter((node) => node.codeDiscount?.title)
        .map((node) => {
            const isBxgy = node.codeDiscount.customerGets?.items?.products != null;
            return {
                id: node.id,
                type: isBxgy ? "BXGY_CODE" : "BASIC",
                code: node.codeDiscount.codes.nodes[0]?.code ?? node.codeDiscount.title,
                status: node.codeDiscount.status,
                percentage: node.codeDiscount.customerGets?.value?.percentage ?? null,
                appliesTo: isBxgy
                    ? (node.codeDiscount.customerGets.items.products.nodes ?? []).map((product) => product.title)
                    : (node.codeDiscount.customerGets?.items?.collections?.nodes ?? []).map((collection) => collection.title),
            };
        });

    const automaticDiscounts = automaticData.automaticDiscountNodes.nodes
        .filter((node) => node.automaticDiscount?.title)
        .map((node) => ({
            id: node.id,
            type: "BXGY_AUTOMATIC",
            code: node.automaticDiscount.title,
            status: node.automaticDiscount.status,
            percentage: null,
            appliesTo: (node.automaticDiscount.customerGets?.items?.products?.nodes ?? []).map((product) => product.title),
        }));

    return { discounts: [...codeDiscounts, ...automaticDiscounts] };
};
//action --write/update 
export const action = async ({ request }) => {
    console.log("Action: DiscountPage");
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const ids = JSON.parse(formData.get("ids") || "[]");
//applying delete button to all the row workable with mutation
//automatic discounts live under a different node type and need a different delete mutation
    const results = await Promise.all(
        ids.map(async (id) => {
            if (id.includes("DiscountAutomaticNode")) {
                const response = await admin.graphql(`
                    #graphql
                    mutation DeleteAutomaticDiscount($id: ID!) {
                        discountAutomaticDelete(id: $id) {
                            deletedAutomaticDiscountId
                            userErrors { field message }
                        }
                    }
                `, { variables: { id } });
                return (await response.json()).data.discountAutomaticDelete;
            }

            const response = await admin.graphql(`
                #graphql
                mutation DeleteDiscountCode($id: ID!) {
                    discountCodeDelete(id: $id) {
                        deletedCodeDiscountId
                        userErrors { field message }
                    }
                }
            `, { variables: { id } });
            return (await response.json()).data.discountCodeDelete;
        }),
    );

    const userErrors = results.flatMap((result) => result.userErrors ?? []);
    return { deleted: ids.length, userErrors };
};
// UI
export default function Discounts() {
    const { discounts } = useLoaderData();
    const { t: { common: c, discounts: t } } = useLanguage();
    const deleteFetcher = useFetcher();
    const deleteResult = deleteFetcher.data;
    const [search, setSearch] = useState("");
    const [pendingDeleteIds, setPendingDeleteIds] = useState([]);

    const filteredDiscounts = discounts.filter((discount) =>
        discount.code.toLowerCase().includes(search.toLowerCase()),
    );
//fetcher.data allow to the data returned from the action or loader
//fetcher.state // "idle" | "loading" | "submitting" defines the state 
//delete button to fetch working for the modal
    useEffect(() => {
        if (deleteFetcher.state === "idle" && deleteResult && !deleteResult.userErrors?.length) {
            setPendingDeleteIds([]);
            document.getElementById("delete-discount-modal")?.hideOverlay?.();
        }
    }, [deleteFetcher.state, deleteResult]);

    const confirmDelete = (ids) => {
        setPendingDeleteIds(ids);
        document.getElementById("delete-discount-modal")?.showOverlay?.();
    };

    const handleDelete = () => {
        deleteFetcher.submit({ ids: JSON.stringify(pendingDeleteIds) }, { method: "post" });
    };
//discount copy code 
    const copyCode = async (code) => {
        await navigator.clipboard.writeText(code);
        shopify.toast.show(t.codeCopiedToast);
    };

    return (
        <s-page heading={t.heading}>
            <s-button slot="primary-action" commandFor="discount-type-modal">
                {t.createDiscount}
            </s-button>

            {deleteResult?.userErrors?.length > 0 && (
                <s-banner tone="critical">
                    {deleteResult.userErrors[0].message}
                </s-banner>
            )}

            <s-modal id="delete-discount-modal" heading={t.deleteDiscountHeading}>
                <s-stack direction="block" gap="base">
                    <s-text>
                        {pendingDeleteIds.length === 1
                            ? t.confirmDeleteOne
                            : format(t.confirmDeleteMany, { count: pendingDeleteIds.length })}
                    </s-text>
                </s-stack>
                <s-button
                    slot="primary-action"
                    variant="primary"
                    tone="critical"
                    onClick={handleDelete}
                    loading={deleteFetcher.state !== "idle"}
                >
                    {c.delete}
                </s-button>
                <s-button slot="secondary-actions" commandFor="delete-discount-modal" command="--hide" variant="tertiary">
                    {c.cancel}
                </s-button>
            </s-modal>

            <s-modal id="discount-type-modal" heading={t.selectDiscountTypeHeading}>
                <s-stack direction="block" gap="small-200">
                    {DISCOUNT_TYPES.map((type) => (
                        <s-clickable key={type.key} href={type.href} padding="base" borderRadius="base" background="subdued">
                            <s-grid gridTemplateColumns="auto 1fr auto" gap="base" alignItems="center">
                                <s-icon type={type.icon} />
                                <s-stack direction="block" gap="small-200">
                                    <s-text type="strong">{t[`type_${type.key}_title`]}</s-text>
                                    <s-text color="subdued">{t[`type_${type.key}_desc`]}</s-text>
                                </s-stack>
                                <s-icon type="chevron-right" />
                            </s-grid>
                        </s-clickable>
                    ))}
                </s-stack>
                <s-button slot="secondary-actions" commandFor="discount-type-modal" command="--hide" variant="tertiary">
                    {c.cancel}
                </s-button>
            </s-modal>

            <s-section padding="none" accessibilityLabel="Discounts table section">
                <s-table>
                    <s-grid slot="filters" gap="small-200" gridTemplateColumns="1fr">
                        <s-text-field
                            label={c.search}
                            labelAccessibilityVisibility="exclusive"
                            icon="search"
                            placeholder={c.search}
                            value={search}
                            onInput={(event) => setSearch(event.currentTarget.value)}
                        />
                    </s-grid>
                    <s-table-header-row>
                        <s-table-header listSlot="primary">{t.discountCode}</s-table-header>
                        <s-table-header format="numeric">{t.percentageOff}</s-table-header>
                        <s-table-header>{t.appliesTo}</s-table-header>
                        <s-table-header>{t.eligibility}</s-table-header>
                        <s-table-header>{c.status}</s-table-header>
                        <s-table-header>{c.action}</s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                        {filteredDiscounts.map((discount) => {
                            const discountNumericId = discount.id.split("/").pop();
                            const menuId = `discount-menu-${discountNumericId}`;

                            return (
                                <s-table-row key={discount.id}>
                                    <s-table-cell>
                                        <s-grid gridTemplateColumns="1fr auto auto" gap="small" alignItems="center">
                                            <s-text>{discount.code}</s-text>
                                            {discount.type !== "BXGY_AUTOMATIC" && (
                                                <>
                                                    <s-button
                                                        icon="clipboard"
                                                        variant="tertiary"
                                                        accessibilityLabel={`Copy ${discount.code}`}
                                                        interestFor={`copy-tooltip-${discountNumericId}`}
                                                        onClick={() => copyCode(discount.code)}
                                                    />
                                                    <s-tooltip id={`copy-tooltip-${discountNumericId}`}>
                                                        <s-text>{t.copyCode}</s-text>
                                                    </s-tooltip>
                                                </>
                                            )}
                                            {discount.type === "BASIC" && (
                                                <>
                                                    <s-button
                                                        icon="edit"
                                                        variant="tertiary"
                                                        href={`/app/discounts/${discountNumericId}`}
                                                        accessibilityLabel={`Edit ${discount.code}`}
                                                        interestFor={`edit-tooltip-${discountNumericId}`}
                                                    />
                                                    <s-tooltip id={`edit-tooltip-${discountNumericId}`}>
                                                        <s-text>{t.updateDiscount}</s-text>
                                                    </s-tooltip>
                                                </>
                                            )}
                                            {(discount.type === "BXGY_CODE" || discount.type === "BXGY_AUTOMATIC") && (
                                                <>
                                                    <s-button
                                                        icon="edit"
                                                        variant="tertiary"
                                                        href={`/app/gift-with-purchase/${discountNumericId}`}
                                                        accessibilityLabel={`Edit ${discount.code}`}
                                                        interestFor={`edit-tooltip-${discountNumericId}`}
                                                    />
                                                    <s-tooltip id={`edit-tooltip-${discountNumericId}`}>
                                                        <s-text>{t.updateDiscount}</s-text>
                                                    </s-tooltip>
                                                </>
                                            )}
                                        </s-grid>
                                    </s-table-cell>
                                    <s-table-cell>
                                        {discount.percentage != null ? `${Math.round(discount.percentage * 100)}%` : "-"}
                                    </s-table-cell>
                                    <s-table-cell>
                                        {discount.appliesTo.length > 0 ? discount.appliesTo.join(", ") : "-"}
                                    </s-table-cell>
                                    <s-table-cell>{c.allCustomers}</s-table-cell>
                                    <s-table-cell>
                                        <s-badge tone={discount.status === "ACTIVE" ? "success" : "neutral"}>
                                            {discount.status === "ACTIVE" ? c.active : discount.status === "DRAFT" ? c.draft : discount.status}
                                        </s-badge>
                                    </s-table-cell>
                                    <s-table-cell>
                                        <s-button icon="menu-horizontal" variant="tertiary" accessibilityLabel="More actions" commandFor={menuId} />
                                        <s-menu id={menuId} accessibilityLabel="Discount actions">
                                            <s-button
                                                variant="tertiary"
                                                tone="critical"
                                                icon="delete"
                                                onClick={() => confirmDelete([discount.id])}
                                            >
                                                {t.deleteDiscountAction}
                                            </s-button>
                                        </s-menu>
                                    </s-table-cell>
                                </s-table-row>
                            );
                        })}
                    </s-table-body>
                </s-table>
            </s-section>
        </s-page>
    );
}
