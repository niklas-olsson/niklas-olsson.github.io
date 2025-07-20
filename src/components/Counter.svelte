<script>
  let count = 0;

  function increment() {
    count += 1;
  }
</script>

<style>
  .counter {
    display: grid;
    font-size: 2em;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    margin-top: 2rem;
    place-items: center;
  }

  .counter-message {
    text-align: center;
  }
</style>

<div class="counter">
  <button on:click={() => count--}>-</button>
  <pre class="counter-message">{count}</pre>
  <button on:click={increment}>+</button>
</div>
