<script>
  export let allWaypoints = [];
  let selectedCategory = 'All';

  // Get unique categories
  $: categories = ['All', ...new Set(allWaypoints.map(w => w.category).sort())];

  // Filter waypoints based on selectedCategory
  $: filteredWaypoints = selectedCategory === 'All'
    ? allWaypoints
    : allWaypoints.filter(w => w.category === selectedCategory);
</script>

<style>
  .filter-container {
    text-align: center;
    margin-bottom: 1.5rem;
  }
  select {
    padding: 0.5rem;
    border-radius: 5px;
    border: 1px solid #ccc;
    font-size: 1em;
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
  .category-tag {
    display: inline-block;
    background-color: #e0e0e0;
    color: #555;
    padding: 0.2em 0.6em;
    border-radius: 3px;
    font-size: 0.8em;
    margin-top: 0.5em;
  }
</style>

<div class="filter-container">
  <label for="category-filter">Filter by Category: </label>
  <select id="category-filter" bind:value={selectedCategory}>
    {#each categories as category}
      <option value={category}>{category}</option>
    {/each}
  </select>
</div>

<ul>
  {#each filteredWaypoints as waypoint (waypoint.url)}
    <li>
      <a href={waypoint.url} target="_blank">{waypoint.title}</a>
      <p>{waypoint.description}</p>
      {#if waypoint.category}
        <span class="category-tag">{waypoint.category}</span>
      {/if}
    </li>
  {/each}
</ul>
