import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import { useLanguage } from "../context/LanguageContext";
//loader is been called to collect the Collection ID from route
// fetches the data from the collection page
//returning back to the component
export const loader = async ({ request, params }) => {
    console.log("laoder called 🔃");
    const { admin } = await authenticate.admin(request);
    //checking if the id is new or edit if new then true(new===new) colleciton new 
    //if edit (127465 === new) then it will return false
    const isNew = params.id === "new";

    if (isNew) {
        return { isNew: true, collection: null, sourceId: null };
    }
//if it is existing page (23232 === new) then below param
    const collectionId = `gid://shopify/Collection/${params.id}`;
//graphql call loader -> query 
    const response = await admin.graphql(`
        #graphql
        query GetCollectionForEdit($id: ID!) {
            collection(id: $id) {
                id
                title
                descriptionHtml
                products(first: 50) {
                    nodes {
                        id
                        title
                        featuredMedia {
                            preview { image { url } }
                        }
                    }
                }
                sources {
                    __typename
                    id
                    title
                }
            }
        }
    `, { variables: { id: collectionId } }); //variable passing now it will shw in the URL and page wil appear
//error handling if the product did'nt found 
    const data = (await response.json()).data;
    if (!data.collection) {
        throw new Response("Collection not found", { status: 404 });
    }
//if there is no single product available then return null 
    const sourceId = data.collection.sources?.[0]?.id ?? null;
//if there is return the ID collection, passes to the front UI which to be visible with merchant
    return { isNew: false, collection: data.collection, sourceId };
};
//action is called to save/change the form data 
//request will show the info for the submitted form; param allows to show URL :23232
export const action = async ({ request, params }) => {
    console.log("action Called: ✔");
    const { admin } = await authenticate.admin(request); //authentication to access the API
    const isNew = params.id === "new";
    const formData = await request.formData(); //recieving form data from the browser end 
    console.log("action form data recieved"); //test
    const payload = JSON.parse(formData.get("payload") || "{}"); //getting paylod only in string parse allows to convert string to js object 

    const { title, description, productIds } = payload; //destructuring it from string to object 
//checksthe title is not empty if empty return error
    if (!title || !title.trim()) {
        return { userErrors: [{ field: ["title"], message: "Title is required" }] };
    }
//if shows /collection/new
    if (isNew) {
        const collectionInput = {
            title,
            sources: [{
                source: {
                    title: "Manual products",
                    //converting the products in to shopify format, map will transform all to the objects shopify format
                    inclusion: { selections: (productIds || []).map((productId) => ({ productId })) },
                },
            }],
        };
        //adding Discriptions                            "output eg: summer collection"
        if (description) collectionInput.descriptionHtml = description;

        const response = await admin.graphql(`
            #graphql
            mutation CreateCollection($collection: CollectionCreateInput!) {
                collectionCreate(collection: $collection) {
                    collection { id }
                    userErrors { field message }
                }
            }
        `, { variables: { collection: collectionInput } });

        const result = (await response.json()).data.collectionCreate;
        if (result.userErrors?.length) {
            return { userErrors: result.userErrors };
        }

        return { success: true };
    }

// -----------------------------------------------------------------------------------------------------
//collection created then show the collection ID //ifTitle
    const collectionId = `gid://shopify/Collection/${params.id}`;
    const { initial, sourceId } = payload;
// if the edit is done to the product title discription media it will be flagged with true or false booleans
    const collectionUpdateInput = { id: collectionId };
    let needsUpdate = true;  //used flag if change is done then
    //if discription or title is changed it will check not matching to previous 
    if (title !== initial.title) {
        collectionUpdateInput.title = title;
        needsUpdate = true;     //this will call if changed
    }
    if (description !== initial.description) {
        collectionUpdateInput.descriptionHtml = description;
        needsUpdate = true;
    }
//mutaion called if update is needed with the help of collectionUpdateInput
    if (needsUpdate) {
        const response = await admin.graphql(`
            #graphql
            mutation UpdateCollectionBasics($collection: CollectionUpdateInput!) {
                collectionUpdate(collection: $collection) {
                    collection { id }
                    userErrors { field message }
                }
            }
        `, { variables: { collection: collectionUpdateInput } });

        const result = (await response.json()).data.collectionUpdate;
        if (result.userErrors?.length) {
            return { userErrors: result.userErrors };
        }
    }
//add product code 
    const initialIds = new Set(initial.productIds);
    const currentIds = new Set(productIds);
    const toAdd = productIds.filter((id) => !initialIds.has(id)).map((productId) => ({ productId }));
    const toRemove = initial.productIds.filter((id) => !currentIds.has(id)).map((productId) => ({ productId }));

    if ((toAdd.length || toRemove.length) && sourceId) {
        const response = await admin.graphql(`
            #graphql
            mutation UpdateCollectionProducts($collectionId: ID!, $sourceId: ID!, $add: [CollectionInclusionProductSelectionInput!]!, $remove: [CollectionInclusionProductSelectionInput!]!) {
                collectionUpdate(
                    collection: {
                        id: $collectionId
                        sourcesToUpdate: [
                            {
                                condition: {
                                    id: $sourceId
                                    inclusion: { selectionsToAdd: $add, selectionsToRemove: $remove }
                                }
                            }
                        ]
                    }
                ) {
                    collection { id }
                    userErrors { field message }
                }
            }
        `, { variables: { collectionId, sourceId, add: toAdd, remove: toRemove } });
//will reflect to frontend 
        const result = (await response.json()).data.collectionUpdate;
        if (result.userErrors?.length) {
            return { userErrors: result.userErrors };
        }
    }
//no error collection created 
    return { success: true };
};
// collection form for the UI
export default function CollectionForm() {
    const { isNew, collection, sourceId } = useLoaderData();
    const { t: { collectionForm: t } } = useLanguage();
    const navigate = useNavigate();
    const fetcher = useFetcher();
    const result = fetcher.data;
    const isSaving = fetcher.state !== "idle";
//basic simple 3 needs to build discription area
    const [title, setTitle] = useState(collection?.title ?? "");
    const [description, setDescription] = useState(collection?.descriptionHtml ?? "");
    const [selectedProducts, setSelectedProducts] = useState(
        (collection?.products.nodes ?? []).map((product) => ({
            id: product.id,
            title: product.title,
            image: product.featuredMedia?.preview?.image?.url ?? null,
        })),
    );
//show the toast banner
    useEffect(() => {
        if (result?.success && !isSaving) {
            shopify.toast.show(isNew ? t.collectionCreatedToast : t.collectionUpdatedToast);
            navigate("/app/collections");
        } else if (result?.userErrors?.length && !isSaving) {
            shopify.toast.show(result.userErrors[0].message, { isError: true });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [result, isSaving]);
//resource picker is been used to to add the product from the products and deselecting
    const handleAddProducts = async () => {
        const picked = await shopify.resourcePicker({
            type: "product",
            multiple: true,
            selectionIds: selectedProducts.map((product) => ({ id: product.id })),
        });
        if (!picked) return;
// allows to add multiple products
        setSelectedProducts((current) => {
            const existingById = new Map(current.map((product) => [product.id, product]));
            return picked.map((product) => existingById.get(product.id) ?? {
                id: product.id,
                title: product.title,
                image: null,
            });
        });
    };
//remove the product from the exiscing 
    const removeProduct = (productId) => {
        setSelectedProducts((current) => current.filter((product) => product.id !== productId));
    };
//savebar discard button
    const handleDiscard = () => {
        navigate("/app/collections");
    };
//savebar submit button
    const handleSubmit = (event) => {
        event.preventDefault();

        const payload = {
            title,
            description,
            productIds: selectedProducts.map((product) => product.id),
        };

        if (!isNew) {
            payload.initial = {
                title: collection.title,
                description: collection.descriptionHtml || "",
                productIds: collection.products.nodes.map((product) => product.id),
            };
            payload.sourceId = sourceId;
        }

        fetcher.submit({ payload: JSON.stringify(payload) }, { method: "post" });
    };
//if new write the collection uI 
    return (
        <s-page heading={isNew ? t.createCollectionHeading : collection.title}>
            <s-link href="/app/collections" slot="breadcrumb-actions">{t.collectionsBreadcrumb}</s-link>

            {result?.userErrors?.length > 0 && (
                <s-banner tone="critical">
                    {result.userErrors[0].message}
                </s-banner>
            )}
{/* //savebar discard */}
            <form data-save-bar data-discard-confirmation onSubmit={handleSubmit} onReset={handleDiscard}>
                <s-stack direction="block" gap="base">
                    <s-section heading={t.titleSection}>
                        <s-text-field
                            label={t.titleSection}
                            name="title"
                            error="Title is required"
                            required
                            placeholder={t.titlePlaceholder}
                            value={title}
                            onInput={(event) => setTitle(event.currentTarget.value)}
                        />
                    </s-section>
{/* Section for discription area */}
                    <s-section heading={t.descriptionSection}>
                        <s-text-area
                            label={t.descriptionSection}
                            name="description"
                            rows={4}
                            placeholder={t.descriptionPlaceholder}
                            value={description}
                            onInput={(event) => setDescription(event.currentTarget.value)}
                        />
                    </s-section>
{/* add products with the help of resource picker */}
                    <s-section heading={t.productsSection}>
                        <s-stack direction="block" gap="base">
                            {selectedProducts.length > 0 && (
                                <s-stack direction="inline" gap="small">
                                    {selectedProducts.map((product) => (
                                        <s-stack key={product.id} direction="block" gap="small-200" alignItems="center">
                                            <s-thumbnail src={product.image} alt={product.title} size="large" />
                                            <s-text>{product.title}</s-text>
                                            <s-button
                                                icon="delete"
                                                variant="tertiary"
                                                tone="critical"
                                                accessibilityLabel={`Remove ${product.title}`}
                                                onClick={() => removeProduct(product.id)}
                                            />
                                        </s-stack>
                                    ))}
                                </s-stack>
                            )}
                            <s-button variant="secondary" icon="plus" onClick={handleAddProducts}>
                                {t.addProduct}
                            </s-button>
                        </s-stack>
                    </s-section>
                </s-stack>
            </form>
        </s-page>
    );
}
