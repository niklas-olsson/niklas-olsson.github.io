<script>
  export let allInsights = [];
  let selectedTags = new Set();
  let showTagOptions = false; // State to control visibility of tag options

  // Get all unique tags from all insights
  $: allUniqueTags = Array.from(new Set(allInsights.flatMap(insight => insight.data.tags || []))).sort();

  // Filter insights based on selected tags
  $: filteredInsights = allInsights.filter(insight => {
    if (selectedTags.size === 0) {
      return true; // Show all if no tags selected
    }
    // Check if insight has ALL selected tags
    return Array.from(selectedTags).every(tag => insight.data.tags && insight.data.tags.includes(tag));
  });

  function toggleTag(tag) {
    if (selectedTags.has(tag)) {
      selectedTags.delete(tag);
    } else {
      selectedTags.add(tag);
    }
    selectedTags = selectedTags; // Trigger Svelte reactivity
  }

  function toggleTagOptions() {
    showTagOptions = !showTagOptions;
  }

  // Close dropdown if clicked outside
  function handleClickOutside(event) {
    if (showTagOptions && !event.target.closest('.filter-container')) {
      showTagOptions = false;
    }
  }
</script>

<svelte:window on:click={handleClickOutside} />

<style>
  .filter-container {
    margin-bottom: 1.5rem;
    padding: 1rem;
    background-color: #f0f0f0;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    position: relative; /* For positioning the dropdown */

    /* New styles for alignment */
    display: flex;
    align-items: center;
    justify-content: center; /* Center the whole row */
    gap: 1rem; /* Space between heading and dropdown */
  }
  .filter-container h3 {
    margin: 0; /* Remove default margin from h3 */
  }
  .selected-tags-display {
    padding: 0.5rem 1rem;
    border: 1px solid #ccc;
    border-radius: 5px;
    background-color: #fff;
    cursor: pointer;
    display: flex;
    justify-content: center; /* Center content within the display */
    align-items: center;
    gap: 0.5rem; /* Space between text and arrow */
    flex-grow: 1; /* Allow it to take available space */
    max-width: 300px; /* Limit width for better appearance */
    font-size: 1em;
  }
  .selected-tags-display span {
    /* flex-grow: 1; Removed to prevent text from pushing arrow */
    text-align: center; /* Center text within its span */
  }
  .selected-tags-display .arrow {
    margin-left: 0; /* No extra margin needed with gap */
    width: 1em; /* Fixed width for arrow to prevent lateral shift */
    text-align: center; /* Center arrow within its fixed width */
  }
  .selected-tags-display .arrow.rotated {
    transform: rotate(180deg);
  }
  .tag-options-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background-color: #fff;
    border: 1px solid #ccc;
    border-radius: 5px;
    box-shadow: 0 4px 8px rgba(0,0,0,0.1);
    z-index: 100;
    padding: 1rem;
    margin-top: 5px;
    text-align: left;
  }
  .tag-checkbox-group {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .tag-checkbox {
    display: inline-flex;
    align-items: center;
    background-color: #e0e0e0;
    color: #555;
    padding: 0.4em 0.8em;
    border-radius: 15px;
    font-size: 0.9em;
    cursor: pointer;
    transition: background-color 0.2s ease, color 0.2s ease;
  }
  .tag-checkbox.selected {
    background-color: #007bff;
    color: white;
  }
  .tag-checkbox input[type="checkbox"] {
    margin-right: 0.5em;
    display: none; /* Hide default checkbox */
  }
  ul {
    list-style: none;
    padding: 0;
  }
  li {
    background-color: #ffffff;
    border: 1px solid #ddd;
    border-radius: 8px;
    margin-bottom: 1rem;
    padding: 1rem;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  }
  li a {
    color: #007bff;
    text-decoration: none;
    font-weight: bold;
    display: block;
    margin-bottom: 0.5rem;
  }
  li a:hover {
    text-decoration: underline;
  }
  li p {
    font-size: 0.9em;
    color: #666;
    margin: 0;
  }
  .tag-list {
    list-style: none;
    padding: 0;
    margin: 0.5rem 0 0 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .tag-list li {
    background-color: #e0e0e0;
    color: #555;
    padding: 0.2em 0.6em;
    border-radius: 3px;
    font-size: 0.8em;
    border: none;
    box-shadow: none;
    margin: 0;
  }
</style>

<div class="filter-container">
  <h3>Filter by Tags:</h3>
  <div class="selected-tags-display" on:click={toggleTagOptions}>
    <span>
      {#if selectedTags.size === 0}
        All Tags
      {:else}
        {Array.from(selectedTags).join(', ')}
      {/if}
    </span>
    <span class="arrow" class:rotated={showTagOptions}>&#9660;</span>
  </div>

  {#if showTagOptions}
    <div class="tag-options-dropdown">
      <div class="tag-checkbox-group">
        {#each allUniqueTags as tag}
          <label class="tag-checkbox" class:selected={selectedTags.has(tag)}>
            <input type="checkbox" on:change={() => toggleTag(tag)} checked={selectedTags.has(tag)} />
            {tag}
          </label>
        {/each}
      </div>
    </div>
  {/if}
</div>

<ul>
  {#each filteredInsights as insight (insight.slug)}
    <li>
      <a href={`/insights/${insight.slug}`}>{insight.data.title}</a>
      <p>{insight.data.description}</p>
      {#if insight.data.tags && insight.data.tags.length > 0}
        <ul class="tag-list">
          {#each insight.data.tags as tag}
            <li>{tag}</li>
          {/each}
        </ul>
      {/if}
    </li>
  {/each}
</ul>