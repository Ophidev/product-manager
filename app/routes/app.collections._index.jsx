import { useLoaderData, useFetcher } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
//read fetch
export const loader = async ({ request }) => {
    //test 
    console.log("laoder: called ✔");
    const { admin } = await authenticate.admin(request);
//fething the data to present on table available in the collection only first 50
    const response = await admin.graphql(`
        #graphql
        query ListCollections {
            collections(first: 50) {
                nodes {
                    id
                    title
                    image { url altText }
                    productsCount { count }
                }
            }
        }
    `);

    const data = (await response.json()).data;
    return { collections: data.collections.nodes };
};
//action to delete the collection 
export const action = async ({ request }) => {
    //test action 
    console.log("action: called");
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData(); //formData peresent as summer collection and more 
    // test 
    console.log("action form data");
    const ids = JSON.parse(formData.get("ids") || "[]"); //collection ID, result in string JSON.parse will make it as array when we click the delete button it share the collection ID 
//to show the delete button will delete whole of which the collection ID is genrated 
    const results = await Promise.all(
        ids.map(async (id) => {
            //to delete the particular colleciton 
            const response = await admin.graphql(`
                #graphql
                mutation DeleteCollection($input: CollectionDeleteInput!) {
                    collectionDelete(input: $input) {
                        deletedCollectionId
                        userErrors { field message }
                    }
                }
            `, { variables: { input: { id } } });
            return (await response.json()).data.collectionDelete;
        }),
    );

    const userErrors = results.flatMap((result) => result.userErrors ?? []);
    return { deleted: ids.length, userErrors };
};
// UI 
export default function Collections() {
    const { collections } = useLoaderData();
    const deleteFetcher = useFetcher();
    const deleteResult = deleteFetcher.data;

    const [search, setSearch] = useState("");
    const [pendingDeleteIds, setPendingDeleteIds] = useState([]);

    const filteredCollections = collections.filter((collection) =>
        collection.title.toLowerCase().includes(search.toLowerCase()),
    );

    useEffect(() => {
        if (deleteFetcher.state === "idle" && deleteResult && !deleteResult.userErrors?.length) {
            setPendingDeleteIds([]);
            document.getElementById("delete-collection-modal")?.hideOverlay?.();
        }
    }, [deleteFetcher.state, deleteResult]);
//delete modal confirmation
    const confirmDelete = (ids) => {
        setPendingDeleteIds(ids);
        document.getElementById("delete-collection-modal")?.showOverlay?.();
    };

    const handleDelete = () => {
        deleteFetcher.submit({ ids: JSON.stringify(pendingDeleteIds) }, { method: "post" });
    };

    return (
        <s-page heading="Collections">
            <s-button slot="primary-action" href="/app/collections/new">
                Create collection
            </s-button>

            {deleteResult?.userErrors?.length > 0 && (
                <s-banner tone="critical">
                    {deleteResult.userErrors[0].message}
                </s-banner>
            )}
{/* if the deletemodal hits */}
            <s-modal id="delete-collection-modal" heading="Delete collection">
                <s-stack direction="block" gap="base">
                    <s-text>
                        {pendingDeleteIds.length === 1
                            ? "Are you sure you want to delete the collection?"
                            : `Are you sure you want to delete ${pendingDeleteIds.length} collections?`}
                    </s-text>
                </s-stack>
                <s-button
                    slot="primary-action"
                    variant="primary"
                    tone="critical"
                    onClick={handleDelete}
                    loading={deleteFetcher.state !== "idle"}
                >
                    Delete
                </s-button>
                <s-button slot="secondary-actions" commandFor="delete-collection-modal" command="--hide" variant="tertiary">
                    Cancel
                </s-button>
            </s-modal>

            <s-section padding="none" accessibilityLabel="Collections table section">
                <s-table>
                    <s-grid slot="filters" gap="small-200" gridTemplateColumns="1fr">
                        <s-text-field
                            label="Search and filter"
                            labelAccessibilityVisibility="exclusive"
                            icon="search"
                            placeholder="Search"
                            value={search}
                            onInput={(event) => setSearch(event.currentTarget.value)}
                        />
                    </s-grid>
                    <s-table-header-row>
                        <s-table-header listSlot="primary">Title</s-table-header>
                        <s-table-header format="numeric">Products</s-table-header>
                        <s-table-header></s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                        {filteredCollections.map((collection) => {
                            const collectionNumericId = collection.id.split("/").pop();
                            const menuId = `collection-menu-${collectionNumericId}`;

                            return (
                                <s-table-row key={collection.id}>
                                    <s-table-cell>
                                        <s-grid gridTemplateColumns="40px 1fr" gap="small" alignItems="center">
                                            <s-box
                                                border="base"
                                                borderRadius="base"
                                                overflow="hidden"
                                                inlineSize="40px"
                                                blockSize="40px"
                                                background="subdued"
                                            >
                                                {collection.image?.url ? (
                                                    <s-image
                                                        objectFit="cover"
                                                        src={collection.image.url}
                                                        alt={collection.image.altText || collection.title}
                                                    />
                                                ) : (
                                                    <s-stack direction="block" alignItems="center" justifyContent="center" blockSize="100%">
                                                        <s-icon type="image" tone="neutral" />
                                                    </s-stack>
                                                )}
                                            </s-box>
                                            <s-link href={`/app/collections/${collectionNumericId}`}>
                                                {collection.title}
                                            </s-link>
                                        </s-grid>
                                    </s-table-cell>
                                    <s-table-cell>{collection.productsCount?.count ?? 0}</s-table-cell>
                                    <s-table-cell>
                                        <s-button icon="menu-vertical" variant="tertiary" accessibilityLabel="More actions" commandFor={menuId} />
                                        <s-menu id={menuId} accessibilityLabel="Collection actions">
                                            <s-button
                                                variant="tertiary"
                                                tone="critical"
                                                icon="delete"
                                                onClick={() => confirmDelete([collection.id])}
                                            >
                                                Delete collection
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
